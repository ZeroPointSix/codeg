import type { EventEnvelope, LiveSessionSnapshot } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import type {
  AttachHandlers,
  AttachOptions,
  EventStream,
  EventStreamSubscription,
} from "@/lib/transport/types"
import type { OpenABSseEvent } from "./types"

interface OpenABStreamDependencies {
  loadSnapshot(
    sessionId: string,
    eventSeq?: number
  ): Promise<LiveSessionSnapshot>
  recover(): Promise<void>
  subscribe(listener: (event: OpenABSseEvent) => void): () => void
}

interface ActiveSubscription {
  connectionId: string
  handlers: AttachHandlers
  detached: boolean
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
    snapshot?: { status?: unknown }
    error?: unknown
  }
  if (event.event === "error" && typeof data.error === "string") {
    return {
      seq,
      connection_id: connectionId,
      type: "error",
      message: data.error,
      agent_type: "openab",
      code: null,
    }
  }
  const status = data.snapshot?.status
  if (event.event !== "status_changed" || typeof status !== "string")
    return null
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
    }
    this.subscriptions.set(subscriptionId, subscription)
    this.ensureSource()
    void this.hydrate(subscription)
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

  private async hydrate(
    subscription: ActiveSubscription,
    eventSeq?: number
  ): Promise<void> {
    try {
      const snapshot = await this.dependencies.loadSnapshot(
        subscription.connectionId,
        eventSeq
      )
      if (!subscription.detached) {
        subscription.handlers.onSnapshot(snapshot, snapshot.event_seq)
      }
    } catch {
      if (!subscription.detached) {
        subscription.handlers.onDetached("connection_gone")
      }
    }
  }

  private async handleEvent(event: OpenABSseEvent): Promise<void> {
    if (isRecoveryEvent(event)) {
      await this.dependencies.recover()
      await Promise.all(
        [...this.subscriptions.values()].map((subscription) =>
          this.hydrate(subscription)
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
    await Promise.all(
      matching.map(async (subscription) => {
        const envelope = lifecycleEnvelope(event, sessionId, seq)
        const snapshotSeq = envelope ? Math.max(0, seq - 1) : seq
        await this.hydrate(subscription, snapshotSeq)
        if (!subscription.detached && envelope) {
          subscription.handlers.onEvent(envelope)
        }
      })
    )
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
