import type { EventEnvelope, LiveSessionSnapshot } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import type {
  AttachHandlers,
  AttachOptions,
  EventStream,
  EventStreamSubscription,
} from "@/lib/transport/types"
import { applyOpenABSseToSnapshot, mapOpenABLastError } from "./adapters"
import type { OpenABSseEvent } from "./types"

interface OpenABStreamDependencies {
  loadSnapshot(
    sessionId: string,
    eventSeq?: number
  ): Promise<LiveSessionSnapshot>
  recover?(): Promise<void>
  subscribe(listener: (event: OpenABSseEvent) => void): () => void
}

interface ActiveSubscription {
  connectionId: string
  handlers: AttachHandlers
  detached: boolean
  lastSnapshot: LiveSessionSnapshot | null
  hydrateInFlight: Promise<void> | null
  queuedHydrate: boolean
  queuedEventSeq?: number
}

export function isOpenABSessionGoneError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const value = error as { status?: unknown; code?: unknown }
  if (value.status === 404) return true
  return value.code === "session_not_found" || value.code === "not_found"
}

function isDestroyedTransportError(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "aborted" &&
    (error as { message?: unknown }).message === "OpenAB transport destroyed"
  )
}

function globalSequence(id: string | null, data: unknown): number {
  if (id) {
    const value = Number(id.slice(id.lastIndexOf(":") + 1))
    if (Number.isSafeInteger(value)) return value
  }
  if (data && typeof data === "object") {
    const value = (data as { sequence?: unknown }).sequence
    if (typeof value === "number" && Number.isSafeInteger(value)) return value
  }
  return 0
}

function sessionIdForEvent(event: OpenABSseEvent): string | null {
  if (!event.data || typeof event.data !== "object") return null
  const data = event.data as {
    session_id?: unknown
    snapshot?: { session_id?: unknown }
  }
  if (typeof data.session_id === "string") return data.session_id
  return typeof data.snapshot?.session_id === "string"
    ? data.snapshot.session_id
    : null
}

function isRecoveryEvent(event: OpenABSseEvent): boolean {
  if (event.event === "cursor_reset") return true
  if (
    event.event !== "error" ||
    !event.data ||
    typeof event.data !== "object"
  ) {
    return false
  }
  const error = (event.data as { error?: unknown }).error
  return (
    error === "event history unavailable" || error === "event stream lagged"
  )
}

function lifecycleEnvelope(
  event: OpenABSseEvent,
  connectionId: string,
  seq: number
): EventEnvelope | null {
  if (!event.data || typeof event.data !== "object") return null
  const data = event.data as {
    snapshot?: { status?: unknown; last_error?: unknown }
    error?: unknown
    code?: unknown
    details?: unknown
    last_error?: unknown
  }
  if (event.event === "error") {
    const lastError =
      mapOpenABLastError(data.last_error) ?? mapOpenABLastError(data.error)
    const message =
      lastError?.message ?? (typeof data.error === "string" ? data.error : null)
    if (!message) return null
    return {
      seq,
      connection_id: connectionId,
      type: "error",
      message,
      agent_type: "openab",
      code:
        lastError?.code ?? (typeof data.code === "string" ? data.code : null),
      details:
        lastError?.details ??
        (typeof data.details === "string" ? data.details : null),
    }
  }
  const status = data.snapshot?.status
  if (event.event !== "status_changed" || typeof status !== "string")
    return null
  if (status === "error" || status === "failed") {
    const lastError = mapOpenABLastError(data.snapshot?.last_error)
    if (lastError) {
      return {
        seq,
        connection_id: connectionId,
        type: "error",
        message: lastError.message,
        agent_type: "openab",
        code: lastError.code ?? null,
        details: lastError.details ?? null,
      }
    }
  }
  if (status === "idle") {
    return {
      seq,
      connection_id: connectionId,
      type: "turn_complete",
      session_id: connectionId,
      stop_reason: "end_turn",
    }
  }
  return {
    seq,
    connection_id: connectionId,
    type: "status_changed",
    status: status === "error" ? "error" : "prompting",
  }
}

export class OpenABEventStream implements EventStream {
  private subscriptions = new Map<string, ActiveSubscription>()
  private unsubscribeSource: (() => void) | null = null

  constructor(private dependencies: OpenABStreamDependencies) {}

  attach(
    connectionId: string,
    _options: AttachOptions,
    handlers: AttachHandlers
  ): EventStreamSubscription {
    const subscriptionId = randomUUID()
    const subscription: ActiveSubscription = {
      connectionId,
      handlers,
      detached: false,
      lastSnapshot: null,
      hydrateInFlight: null,
      queuedHydrate: false,
    }
    this.subscriptions.set(subscriptionId, subscription)
    this.ensureSource()
    void this.enqueueHydrate(subscription)
    return {
      subscriptionId,
      detach: () => {
        subscription.detached = true
        this.subscriptions.delete(subscriptionId)
        if (this.subscriptions.size === 0) {
          this.unsubscribeSource?.()
          this.unsubscribeSource = null
        }
      },
    }
  }

  destroy(): void {
    this.unsubscribeSource?.()
    this.unsubscribeSource = null
    for (const subscription of this.subscriptions.values()) {
      subscription.detached = true
    }
    this.subscriptions.clear()
  }

  private ensureSource(): void {
    if (this.unsubscribeSource) return
    this.unsubscribeSource = this.dependencies.subscribe((event) => {
      void this.handleEvent(event)
    })
  }

  private enqueueHydrate(
    subscription: ActiveSubscription,
    eventSeq?: number
  ): Promise<void> {
    subscription.queuedHydrate = true
    subscription.queuedEventSeq = eventSeq
    if (subscription.hydrateInFlight) return subscription.hydrateInFlight
    const run = (async () => {
      try {
        do {
          subscription.queuedHydrate = false
          const seq = subscription.queuedEventSeq
          subscription.queuedEventSeq = undefined
          await this.hydrateOnce(subscription, seq)
        } while (!subscription.detached && subscription.queuedHydrate)
      } finally {
        subscription.hydrateInFlight = null
        if (!subscription.detached && subscription.queuedHydrate) {
          void this.enqueueHydrate(subscription, subscription.queuedEventSeq)
        }
      }
    })()
    subscription.hydrateInFlight = run
    return run
  }

  private async hydrateOnce(
    subscription: ActiveSubscription,
    eventSeq?: number
  ): Promise<void> {
    try {
      const snapshot = await this.dependencies.loadSnapshot(
        subscription.connectionId,
        eventSeq
      )
      if (subscription.detached) return
      subscription.lastSnapshot = snapshot
      subscription.handlers.onSnapshot(snapshot, snapshot.event_seq)
    } catch (error) {
      if (subscription.detached || isDestroyedTransportError(error)) return
      subscription.handlers.onDetached(
        isOpenABSessionGoneError(error) ? "connection_gone" : "lagged"
      )
    }
  }

  private applyIncremental(
    subscription: ActiveSubscription,
    event: OpenABSseEvent,
    seq: number
  ): boolean {
    if (!subscription.lastSnapshot) return false
    const next = applyOpenABSseToSnapshot(subscription.lastSnapshot, event, seq)
    if (!next) return false
    subscription.lastSnapshot = next
    if (!subscription.detached) {
      subscription.handlers.onSnapshot(next, next.event_seq)
    }
    return true
  }

  private async handleEvent(event: OpenABSseEvent): Promise<void> {
    if (isRecoveryEvent(event)) {
      try {
        await this.dependencies.recover?.()
      } catch {
        // Per-session hydration still repairs active views when global refresh fails.
      }
      await Promise.all(
        [...this.subscriptions.values()].map((subscription) =>
          this.enqueueHydrate(subscription)
        )
      )
      return
    }

    const sessionId = sessionIdForEvent(event)
    if (!sessionId) return
    const seq = globalSequence(event.id, event.data)
    const matching = [...this.subscriptions.values()].filter(
      (subscription) => subscription.connectionId === sessionId
    )
    for (const subscription of matching) {
      const envelope = lifecycleEnvelope(event, sessionId, seq)
      if (this.applyIncremental(subscription, event, seq)) {
        if (!subscription.detached && envelope) {
          subscription.handlers.onEvent(envelope)
        }
        continue
      }
      const snapshotSeq = envelope ? Math.max(0, seq - 1) : seq
      void this.enqueueHydrate(subscription, snapshotSeq).then(() => {
        if (!subscription.detached && envelope) {
          subscription.handlers.onEvent(envelope)
        }
      })
    }
  }
}

export function parseSseChunk(
  buffer: string,
  chunk: string
): { events: OpenABSseEvent[]; rest: string } {
  const normalized = (buffer + chunk).replace(/\r\n/g, "\n")
  const frames = normalized.split("\n\n")
  const rest = frames.pop() ?? ""
  const events: OpenABSseEvent[] = []

  for (const frame of frames) {
    let id: string | null = null
    let event = "message"
    const data: string[] = []
    for (const line of frame.split("\n")) {
      if (line.startsWith(":")) continue
      const separator = line.indexOf(":")
      const field = separator === -1 ? line : line.slice(0, separator)
      const value =
        separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "")
      if (field === "id") id = value
      if (field === "event") event = value
      if (field === "data") data.push(value)
    }
    if (data.length === 0) continue
    try {
      events.push({ id, event, data: JSON.parse(data.join("\n")) })
    } catch {
      // Malformed server events are ignored; the next valid event or recovery
      // diagnostic will reconcile state from a fresh snapshot.
    }
  }

  return { events, rest }
}
