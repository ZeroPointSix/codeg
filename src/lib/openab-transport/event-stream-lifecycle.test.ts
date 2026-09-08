import { afterEach, describe, expect, it, vi } from "vitest"
import type { EventEnvelope, LiveSessionSnapshot } from "@/lib/types"
import { OpenABEventStream, OPENAB_STALL_TIMEOUT_MS } from "./event-stream"
import type { OpenABSseEvent } from "./types"

const ID = "admin:test/session"
const streams = new Set<OpenABEventStream>()
function snapshot(
  patch: Partial<LiveSessionSnapshot> = {}
): LiveSessionSnapshot {
  return {
    connection_id: ID,
    event_seq: 0,
    status: "prompting",
    last_error: null,
    live_message: {
      id: "assistant-1",
      role: "assistant",
      content: [{ kind: "text", text: "hello" }],
      started_at: "2026-09-08T00:00:00Z",
    },
    active_tool_calls: [],
    ...patch,
  } as LiveSessionSnapshot
}
function harness(load = vi.fn(async () => snapshot())) {
  let source: (event: OpenABSseEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const onStatus = vi.fn()
  const handlers = {
    onSnapshot: vi.fn(),
    onReplay: vi.fn(),
    onEvent: vi.fn(),
    onDetached: vi.fn(),
  }
  const stream = new OpenABEventStream({
    loadSnapshot: load,
    onStatus,
    subscribe: (fn) => {
      source = fn
      return unsubscribe
    },
  })
  streams.add(stream)
  const attach = () => stream.attach(ID, {}, handlers)
  const emit = (event: OpenABSseEvent) => source(event)
  const status = (value: string, id = "g:1", sessionId = ID) =>
    emit({
      id,
      event: "status_changed",
      data: { snapshot: { session_id: sessionId, status: value } },
    })
  return { stream, handlers, load, attach, emit, status, unsubscribe, onStatus }
}
const flush = () => vi.advanceTimersByTimeAsync(0)
afterEach(() => {
  for (const stream of streams) stream.destroy()
  streams.clear()
  vi.useRealTimers()
})

describe("OpenAB lifecycle delivery", () => {
  it("gives an empty cold snapshot a usable positive ACP sequence", async () => {
    vi.useFakeTimers()
    const h = harness(
      vi.fn(async () =>
        snapshot({
          status: "connected",
          live_message: null,
          selectors_ready: true,
        })
      )
    )
    h.stream.attach(ID, { sinceSeq: 200 }, h.handlers)
    await flush()
    expect(h.handlers.onSnapshot.mock.lastCall?.[0]).toMatchObject({
      status: "connected",
      selectors_ready: true,
    })
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].event_seq).toBeGreaterThan(
      200
    )
  })

  it("settles the live message before clearing it and never deduplicates away turn_complete", async () => {
    vi.useFakeTimers()
    const h = harness()
    let highWater = 0
    let live: LiveSessionSnapshot | null = null
    const completed: unknown[] = []
    h.handlers.onSnapshot.mockImplementation((next: LiveSessionSnapshot) => {
      if (next.event_seq <= highWater) return
      highWater = next.event_seq
      live = next
    })
    h.handlers.onEvent.mockImplementation((event: EventEnvelope) => {
      if (event.seq <= highWater) return
      highWater = event.seq
      if (event.type === "turn_complete")
        completed.push(live?.live_message?.content)
    })
    h.attach()
    await flush()
    h.status("idle", "g:42")
    expect(completed).toEqual([[{ kind: "text", text: "hello" }]])
    const final = h.handlers.onSnapshot.mock.lastCall?.[0]
    expect(final).toMatchObject({
      status: "connected",
      live_message: null,
      active_tool_calls: [],
    })
    expect(final.event_seq).toBeGreaterThan(
      h.handlers.onEvent.mock.lastCall?.[0].seq
    )
  })

  it.each([
    "idle",
    "connected",
    "cancelled",
    "failed",
    "error",
    "exited",
    "disconnected",
  ])("does not turn %s into prompting", async (status) => {
    vi.useFakeTimers()
    const h = harness()
    h.attach()
    await flush()
    h.status(status)
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].status).not.toBe(
      "prompting"
    )
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].live_message).toBeNull()
    if (status === "failed" || status === "error")
      expect(h.handlers.onEvent.mock.lastCall?.[0].type).toBe("error")
  })

  it("deduplicates within a wire generation but accepts a lower sequence after restart", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.attach()
    await flush()
    h.status("idle", "old:90")
    const sequence = h.handlers.onSnapshot.mock.lastCall?.[0].event_seq
    const calls = h.handlers.onSnapshot.mock.calls.length
    h.status("running", "old:90")
    expect(h.handlers.onSnapshot).toHaveBeenCalledTimes(calls)
    h.status("running", "new:1")
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].status).toBe("prompting")
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].event_seq).toBeGreaterThan(
      sequence
    )
  })

  it("does not apply a different session's activity to this subscription", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.attach()
    await flush()
    h.status("idle", "g:1", "admin:other")
    expect(h.handlers.onSnapshot).toHaveBeenCalledTimes(1)
    expect(h.handlers.onEvent).not.toHaveBeenCalled()
  })

  it("ignores a REST snapshot that started before a newer terminal event", async () => {
    vi.useFakeTimers()
    let release!: (value: LiveSessionSnapshot) => void
    const deferred = new Promise<LiveSessionSnapshot>((resolve) => {
      release = resolve
    })
    const load = vi
      .fn(async () => snapshot())
      .mockImplementationOnce(async () => snapshot())
      .mockImplementationOnce(() => deferred)
    const h = harness(load)
    h.attach()
    await flush()
    const refresh = h.stream.reconcile(ID)
    h.status("idle", "g:50")
    release(snapshot({ event_seq: 49 }))
    await refresh
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].status).toBe("connected")
  })

  it("reports a bounded stream failure after reconciling two minutes without progress", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.attach()
    await flush()
    await vi.advanceTimersByTimeAsync(OPENAB_STALL_TIMEOUT_MS)
    expect(h.load).toHaveBeenCalledTimes(2)
    expect(h.handlers.onEvent.mock.lastCall?.[0]).toMatchObject({
      type: "error",
      code: "stream_stalled",
    })
    expect(h.handlers.onSnapshot.mock.lastCall?.[0]).toMatchObject({
      status: "error",
      live_message: null,
    })
    expect(
      h.handlers.onEvent.mock.calls.some(
        ([event]) => event.type === "turn_complete"
      )
    ).toBe(false)
    await vi.advanceTimersByTimeAsync(OPENAB_STALL_TIMEOUT_MS)
    expect(h.load).toHaveBeenCalledTimes(2)
  })

  it("recovers a lost terminal event from REST rather than declaring a stall", async () => {
    vi.useFakeTimers()
    const h = harness(
      vi
        .fn(async () => snapshot())
        .mockImplementationOnce(async () => snapshot())
        .mockImplementationOnce(async () =>
          snapshot({ status: "connected", live_message: null })
        )
    )
    h.attach()
    await flush()
    await vi.advanceTimersByTimeAsync(OPENAB_STALL_TIMEOUT_MS)
    expect(h.handlers.onEvent.mock.lastCall?.[0].type).toBe("turn_complete")
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].status).toBe("connected")
  })

  it("does not count repeated running status notifications as output progress", async () => {
    vi.useFakeTimers()
    const h = harness()
    h.attach()
    await flush()
    await vi.advanceTimersByTimeAsync(OPENAB_STALL_TIMEOUT_MS - 1000)
    h.status("running", "g:2")
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.handlers.onEvent.mock.lastCall?.[0]).toMatchObject({
      type: "error",
      code: "stream_stalled",
    })
  })

  it("cancels the watchdog when detached", async () => {
    vi.useFakeTimers()
    const h = harness()
    const sub = h.attach()
    await flush()
    sub.detach()
    await vi.advanceTimersByTimeAsync(OPENAB_STALL_TIMEOUT_MS * 2)
    expect(h.load).toHaveBeenCalledTimes(1)
    expect(h.unsubscribe).toHaveBeenCalledOnce()
    expect(h.handlers.onEvent).not.toHaveBeenCalled()
  })
})
