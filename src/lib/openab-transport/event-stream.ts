import type { EventEnvelope, LiveSessionSnapshot } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import type {
  AttachHandlers,
  AttachOptions,
  EventStream,
  EventStreamSubscription,
} from "@/lib/transport/types"
import {
  applyOpenABSseToSnapshot,
  mapOpenABLastError,
  mapOpenABStatus,
} from "./adapters"
import type { OpenABSseEvent } from "./types"

interface OpenABStreamDependencies {
  loadSnapshot(
    sessionId: string,
    eventSeq?: number
  ): Promise<LiveSessionSnapshot>
  recover?(): Promise<void>
  onStatus?(sessionId: string, status: string): void
  subscribe(listener: (event: OpenABSseEvent) => void): () => void
}

export const OPENAB_STALL_TIMEOUT_MS = 120_000

interface ActiveSubscription {
  id: string
  connectionId: string
  handlers: AttachHandlers
  detached: boolean
  lastSnapshot: LiveSessionSnapshot | null
  hydrateInFlight: Promise<void> | null
  queuedHydrate: boolean
  revision: number
  wireGeneration: string | null
  wireSequence: number
  lastProgressAt: number
  progressVersion: number
  stallCheckInFlight: boolean
  stallTimer: ReturnType<typeof setTimeout> | null
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

function turnCompleteEnvelope(
  connectionId: string,
  seq: number,
  stopReason: "cancelled" | "end_turn" = "end_turn"
): EventEnvelope {
  return {
    seq,
    connection_id: connectionId,
    type: "turn_complete",
    session_id: connectionId,
    stop_reason: stopReason,
  }
}

function isClientStreamStall(code: string | null | undefined): boolean {
  return code === "stream_stalled"
}

function rawSidebarStatus(
  event: OpenABSseEvent,
  snapshotStatus: string
): string {
  if (event.event === "exited") return "exited"
  if (event.event === "error") return "error"
  if (event.data && typeof event.data === "object") {
    const status = (event.data as { snapshot?: { status?: unknown } }).snapshot
      ?.status
    if (typeof status === "string") return status
  }
  return snapshotStatus
}

function lifecycleEnvelopes(
  event: OpenABSseEvent,
  connectionId: string,
  seq: number
): EventEnvelope[] {
  if (!event.data || typeof event.data !== "object") {
    if (event.event === "exited") {
      return [turnCompleteEnvelope(connectionId, seq, "cancelled")]
    }
    return []
  }
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
    if (!message) return []
    const errorEnvelope: EventEnvelope = {
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
    if (isClientStreamStall(errorEnvelope.code)) return [errorEnvelope]
    return [errorEnvelope, turnCompleteEnvelope(connectionId, seq)]
  }
  if (event.event === "exited") {
    return [turnCompleteEnvelope(connectionId, seq, "cancelled")]
  }
  const status = data.snapshot?.status
  if (event.event !== "status_changed" || typeof status !== "string") return []
  if (status === "error" || status === "failed") {
    const lastError = mapOpenABLastError(data.snapshot?.last_error)
    const errorEnvelope: EventEnvelope = {
      seq,
      connection_id: connectionId,
      type: "error",
      message: lastError?.message ?? "OpenAB session failed",
      agent_type: "openab",
      code: lastError?.code ?? null,
      details: lastError?.details ?? null,
    }
    if (isClientStreamStall(errorEnvelope.code)) return [errorEnvelope]
    return [errorEnvelope, turnCompleteEnvelope(connectionId, seq)]
  }
  if (
    [
      "idle",
      "connected",
      "completed",
      "cancelled",
      "exited",
      "disconnected",
    ].includes(status)
  ) {
    return [
      turnCompleteEnvelope(
        connectionId,
        seq,
        status === "cancelled" || status === "exited" ? "cancelled" : "end_turn"
      ),
    ]
  }
  return [
    {
      seq,
      connection_id: connectionId,
      type: "status_changed",
      status: mapOpenABStatus(status),
    },
  ]
}

function progressFingerprint(snapshot: LiveSessionSnapshot): string {
  return JSON.stringify([
    snapshot.status,
    snapshot.live_message?.id,
    snapshot.live_message?.content,
    snapshot.active_tool_calls,
  ])
}

export class OpenABEventStream implements EventStream {
  private subscriptions = new Map<string, ActiveSubscription>()
  private unsubscribeSource: (() => void) | null = null
  // ACP uses one integer cursor. OpenAB uses generation:sequence and may reset
  // its sequence to zero. Never mix the wire cursor with the delivery cursor.
  private deliverySequences = new Map<string, number>()

  constructor(private dependencies: OpenABStreamDependencies) {}

  stampSnapshot(snapshot: LiveSessionSnapshot): LiveSessionSnapshot {
    return {
      ...snapshot,
      event_seq: this.nextSequence(snapshot.connection_id, snapshot.event_seq),
    }
  }

  async reconcile(connectionId?: string): Promise<void> {
    await Promise.all(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            !connectionId || subscription.connectionId === connectionId
        )
        .map((subscription) => this.enqueueHydrate(subscription))
    )
  }

  private nextSequence(connectionId: string, minimum = 0): number {
    const seq =
      Math.max(this.deliverySequences.get(connectionId) ?? 0, minimum) + 1
    this.deliverySequences.set(connectionId, seq)
    return seq
  }

  attach(
    connectionId: string,
    options: AttachOptions,
    handlers: AttachHandlers
  ): EventStreamSubscription {
    const subscriptionId = randomUUID()
    this.nextSequence(connectionId, options.sinceSeq ?? 0)
    const subscription: ActiveSubscription = {
      id: subscriptionId,
      connectionId,
      handlers,
      detached: false,
      lastSnapshot: null,
      hydrateInFlight: null,
      queuedHydrate: false,
      revision: 0,
      wireGeneration: null,
      wireSequence: -1,
      lastProgressAt: Date.now(),
      progressVersion: 0,
      stallCheckInFlight: false,
      stallTimer: null,
    }
    this.subscriptions.set(subscriptionId, subscription)
    this.ensureSource()
    void this.enqueueHydrate(subscription)
    return { subscriptionId, detach: () => this.detach(subscription) }
  }

  private detach(subscription: ActiveSubscription): void {
    subscription.detached = true
    if (subscription.stallTimer) clearTimeout(subscription.stallTimer)
    subscription.stallTimer = null
    this.subscriptions.delete(subscription.id)
    if (this.subscriptions.size === 0) {
      this.unsubscribeSource?.()
      this.unsubscribeSource = null
    }
  }

  destroy(): void {
    for (const subscription of [...this.subscriptions.values()])
      this.detach(subscription)
    this.deliverySequences.clear()
  }

  private ensureSource(): void {
    if (this.unsubscribeSource) return
    this.unsubscribeSource = this.dependencies.subscribe((event) => {
      void this.handleEvent(event)
    })
  }

  private publish(
    subscription: ActiveSubscription,
    snapshot: LiveSessionSnapshot,
    event?: OpenABSseEvent
  ): void {
    if (subscription.detached) return
    const previous = subscription.lastSnapshot
    const changed =
      !previous ||
      progressFingerprint(previous) !== progressFingerprint(snapshot)
    if (changed) {
      subscription.lastProgressAt = Date.now()
      subscription.progressVersion += 1
    }
    // Let terminal side effects consume the live message BEFORE clearing it.
    // The following snapshot must have a strictly higher ACP sequence too.
    const boundary = event ?? {
      id: null,
      event: "status_changed",
      data: {
        snapshot: { status: snapshot.status, last_error: snapshot.last_error },
      },
    }
    const envelopes = previous
      ? lifecycleEnvelopes(boundary, subscription.connectionId, 0)
      : []
    for (const envelope of envelopes) {
      const shouldPublish =
        envelope.type === "turn_complete"
          ? previous?.status === "prompting"
          : previous?.status !== snapshot.status ||
            JSON.stringify(previous?.last_error) !==
              JSON.stringify(snapshot.last_error)
      if (!shouldPublish) continue
      subscription.handlers.onEvent({
        ...envelope,
        seq: this.nextSequence(subscription.connectionId),
      })
    }
    if (subscription.detached) return
    const stamped = this.stampSnapshot(snapshot)
    subscription.lastSnapshot = stamped
    subscription.handlers.onSnapshot(stamped, stamped.event_seq)
    if (previous?.status !== snapshot.status) {
      this.dependencies.onStatus?.(
        subscription.connectionId,
        rawSidebarStatus(boundary, snapshot.status)
      )
    }
    this.scheduleStallCheck(subscription)
  }

  private scheduleStallCheck(subscription: ActiveSubscription): void {
    if (subscription.stallTimer) clearTimeout(subscription.stallTimer)
    subscription.stallTimer = null
    if (
      subscription.detached ||
      subscription.lastSnapshot?.status !== "prompting" ||
      subscription.stallCheckInFlight
    )
      return
    subscription.stallTimer = setTimeout(
      () => {
        subscription.stallTimer = null
        void this.checkForStall(subscription)
      },
      Math.max(
        1000,
        OPENAB_STALL_TIMEOUT_MS - (Date.now() - subscription.lastProgressAt)
      )
    )
  }

  private async checkForStall(subscription: ActiveSubscription): Promise<void> {
    if (subscription.stallCheckInFlight) return
    subscription.stallCheckInFlight = true
    try {
      await this.reconcileStalled(subscription)
    } finally {
      subscription.stallCheckInFlight = false
      this.scheduleStallCheck(subscription)
    }
  }

  private async reconcileStalled(
    subscription: ActiveSubscription
  ): Promise<void> {
    const previous = subscription.lastSnapshot
    if (subscription.detached || previous?.status !== "prompting") return
    const version = subscription.progressVersion
    try {
      const snapshot = await this.dependencies.loadSnapshot(
        subscription.connectionId
      )
      if (subscription.detached || version !== subscription.progressVersion)
        return
      if (progressFingerprint(previous) !== progressFingerprint(snapshot)) {
        this.publish(subscription, snapshot)
        return
      }
    } catch {
      if (subscription.detached || version !== subscription.progressVersion)
        return
    }
    // This is a client stream failure, NOT evidence that the remote turn ended.
    // Do not silently cancel a potentially long-running remote tool.
    const lastError = {
      message:
        "No OpenAB progress for 2 minutes. Reconnect to check the remote turn or stop it; it may still be running.",
      code: "stream_stalled",
      details:
        "The client observed no new output or tool progress, then attempted a REST reconciliation.",
    }
    this.publish(subscription, {
      ...previous,
      status: "error",
      live_message: null,
      active_tool_calls: [],
      last_error: lastError,
    })
  }

  private enqueueHydrate(subscription: ActiveSubscription): Promise<void> {
    subscription.queuedHydrate = true
    if (subscription.hydrateInFlight) return subscription.hydrateInFlight
    const run = (async () => {
      try {
        do {
          subscription.queuedHydrate = false
          const revision = subscription.revision
          try {
            const snapshot = await this.dependencies.loadSnapshot(
              subscription.connectionId,
              undefined
            )
            if (subscription.detached) return
            // A REST response begun before a live event must not rewind it.
            if (revision !== subscription.revision) continue
            this.publish(subscription, snapshot)
          } catch (error) {
            if (subscription.detached || isDestroyedTransportError(error))
              return
            // Remove first: onDetached may synchronously install a replacement.
            this.detach(subscription)
            subscription.handlers.onDetached(
              isOpenABSessionGoneError(error) ? "connection_gone" : "lagged"
            )
          }
        } while (!subscription.detached && subscription.queuedHydrate)
      } finally {
        subscription.hydrateInFlight = null
      }
    })()
    subscription.hydrateInFlight = run
    return run
  }

  private async handleEvent(event: OpenABSseEvent): Promise<void> {
    if (isRecoveryEvent(event)) {
      try {
        await this.dependencies.recover?.()
      } catch {
        // Active views can still recover if refreshing the global list failed.
      }
      await Promise.all(
        [...this.subscriptions.values()].map((subscription) => {
          subscription.wireGeneration = null
          subscription.wireSequence = -1
          return this.enqueueHydrate(subscription)
        })
      )
      return
    }
    const sessionId = sessionIdForEvent(event)
    if (!sessionId) return
    const wireSeq = globalSequence(event.id, event.data)
    const generation = event.id?.slice(0, event.id.lastIndexOf(":")) ?? null
    for (const subscription of [...this.subscriptions.values()]) {
      if (subscription.connectionId !== sessionId || subscription.detached)
        continue
      if (
        event.id &&
        generation === subscription.wireGeneration &&
        wireSeq <= subscription.wireSequence
      )
        continue
      subscription.wireGeneration = generation
      subscription.wireSequence = wireSeq
      subscription.revision += 1
      const next =
        subscription.lastSnapshot &&
        applyOpenABSseToSnapshot(subscription.lastSnapshot, event, 0)
      if (next) this.publish(subscription, next, event)
      else void this.enqueueHydrate(subscription)
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
