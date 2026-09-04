import type { LiveSessionSnapshot } from "@/lib/types"
import type { OpenABSseEvent } from "./types"
import {
  isOpenABSessionGoneError,
  OpenABEventStream,
  parseSseChunk,
} from "./event-stream"

function handlers() {
  return {
    onSnapshot: vi.fn(),
    onReplay: vi.fn(),
    onEvent: vi.fn(),
    onDetached: vi.fn(),
  }
}

describe("OpenAB SSE", () => {
  it("parses CRLF frames split across fetch chunks and preserves full ids", () => {
    const first = parseSseChunk(
      "",
      'id: generation-a:12\r\nevent: status_changed\r\ndata: {"snapshot":'
    )
    const second = parseSseChunk(
      first.rest,
      '{"session_id":"slack/thread:1","status":"idle"}}\r\n\r\n'
    )

    expect(first.events).toEqual([])
    expect(second.rest).toBe("")
    expect(second.events).toEqual([
      {
        id: "generation-a:12",
        event: "status_changed",
        data: {
          snapshot: {
            session_id: "slack/thread:1",
            status: "idle",
          },
        },
      },
    ])
  })

  it("rehydrates every attached session when global recovery fails", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const loadSnapshot = vi.fn(
      async (sessionId: string, eventSeq = 7) =>
        ({
          connection_id: sessionId,
          event_seq: eventSeq,
        }) as LiveSessionSnapshot
    )
    const recover = vi.fn(async () => {
      throw new Error("global refresh failed")
    })
    const stream = new OpenABEventStream({
      loadSnapshot,
      recover,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const nextHandlers = handlers()

    stream.attach("opaque/session:1", {}, nextHandlers)
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1))

    listener({ id: "generation-b:1", event: "cursor_reset", data: {} })

    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2))
    expect(recover).toHaveBeenCalledOnce()
    expect(loadSnapshot).toHaveBeenLastCalledWith("opaque/session:1", undefined)
  })

  it("recovers from lagged-stream errors the same way as cursor reset", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const loadSnapshot = vi.fn(
      async (sessionId: string) =>
        ({
          connection_id: sessionId,
          event_seq: 9,
        }) as LiveSessionSnapshot
    )
    const recover = vi.fn(async () => {
      throw new Error("list failed")
    })
    const stream = new OpenABEventStream({
      loadSnapshot,
      recover,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const nextHandlers = handlers()

    stream.attach("opaque/session:1", {}, nextHandlers)
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1))

    listener({
      id: "generation-c:8",
      event: "error",
      data: { error: "event stream lagged" },
    })

    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2))
    expect(recover).toHaveBeenCalledOnce()
    expect(nextHandlers.onDetached).not.toHaveBeenCalled()
    stream.destroy()
  })

  it("applies status_changed from the event payload without a second hydrate", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const loadSnapshot = vi.fn(
      async (sessionId: string) =>
        ({
          connection_id: sessionId,
          event_seq: 7,
          status: "prompting",
          last_error: null,
        }) as LiveSessionSnapshot
    )
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const nextHandlers = handlers()

    stream.attach("opaque/session:1", {}, nextHandlers)
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1))

    listener({
      id: "generation-a:42",
      event: "status_changed",
      data: {
        snapshot: { session_id: "opaque/session:1", status: "idle" },
      },
    })

    await vi.waitFor(() =>
      expect(nextHandlers.onEvent).toHaveBeenCalledTimes(1)
    )
    expect(loadSnapshot).toHaveBeenCalledTimes(1)
    expect(nextHandlers.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        seq: 42,
        connection_id: "opaque/session:1",
        type: "turn_complete",
      })
    )
  })

  it("coalesces high-frequency transcript frames into a single in-flight hydrate", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let loads = 0
    const loadSnapshot = vi.fn(async (sessionId: string) => {
      loads += 1
      if (loads === 1) await gate
      return {
        connection_id: sessionId,
        event_seq: loads,
        status: "prompting",
      } as LiveSessionSnapshot
    })
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const nextHandlers = handlers()
    stream.attach("opaque/session:1", {}, nextHandlers)

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      listener({
        id: `generation-a:${sequence}`,
        event: "transcript",
        data: { session_id: "opaque/session:1", sequence },
      })
    }

    expect(loadSnapshot).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() =>
      expect(loadSnapshot.mock.calls.length).toBeGreaterThan(1)
    )
    expect(loadSnapshot.mock.calls.length).toBeLessThanOrEqual(3)
    stream.destroy()
  })

  it("upserts high-frequency entry revisions without extra REST hydrates", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const loadSnapshot = vi.fn(
      async (sessionId: string) =>
        ({
          connection_id: sessionId,
          event_seq: 0,
          status: "prompting",
          live_message: null,
          active_tool_calls: [],
        }) as unknown as LiveSessionSnapshot
    )
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const nextHandlers = handlers()
    stream.attach("opaque/session:1", {}, nextHandlers)
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1))

    for (let sequence = 1; sequence <= 20; sequence += 1) {
      listener({
        id: `generation-a:${sequence}`,
        event: "transcript",
        data: {
          session_id: "opaque/session:1",
          sequence,
          entry: {
            entry_id: "assistant-1",
            sequence,
            role: "assistant",
            content: `token-${sequence}`,
            status: "streaming",
          },
        },
      })
    }

    expect(loadSnapshot).toHaveBeenCalledTimes(1)
    expect(nextHandlers.onSnapshot).toHaveBeenCalled()
    const last = nextHandlers.onSnapshot.mock.calls[
      nextHandlers.onSnapshot.mock.calls.length - 1
    ]?.[0] as LiveSessionSnapshot | undefined
    expect(last?.live_message?.content).toEqual([
      { kind: "text", text: "token-20" },
    ])
    stream.destroy()
  })

  it("treats a transient loadSnapshot failure as lagged recovery, not connection_gone", async () => {
    const loadSnapshot = vi.fn(async () => {
      throw { status: 502, message: "bad gateway" }
    })
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: () => () => {},
    })
    const nextHandlers = handlers()
    stream.attach("opaque/session:1", {}, nextHandlers)
    await vi.waitFor(() => expect(nextHandlers.onDetached).toHaveBeenCalled())
    expect(nextHandlers.onDetached).toHaveBeenCalledWith("lagged")
    expect(isOpenABSessionGoneError({ status: 502 })).toBe(false)
    stream.destroy()
  })

  it("treats a missing session as connection_gone", async () => {
    const loadSnapshot = vi.fn(async () => {
      throw { status: 404, code: "session_not_found", message: "gone" }
    })
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: () => () => {},
    })
    const nextHandlers = handlers()
    stream.attach("opaque/session:1", {}, nextHandlers)
    await vi.waitFor(() =>
      expect(nextHandlers.onDetached).toHaveBeenCalledWith("connection_gone")
    )
    expect(isOpenABSessionGoneError({ status: 404 })).toBe(true)
    stream.destroy()
  })

  it("surfaces snapshot.last_error on status_changed error frames", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const loadSnapshot = vi.fn(
      async (sessionId: string) =>
        ({
          connection_id: sessionId,
          event_seq: 1,
          status: "prompting",
          last_error: null,
        }) as LiveSessionSnapshot
    )
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const nextHandlers = handlers()
    stream.attach("opaque/session:1", {}, nextHandlers)
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1))

    listener({
      id: "generation-a:8",
      event: "status_changed",
      data: {
        snapshot: {
          session_id: "opaque/session:1",
          status: "error",
          last_error: {
            message: "model refused",
            code: "turn_failed_refusal",
            details: "content filter",
          },
        },
      },
    })

    await vi.waitFor(() => expect(nextHandlers.onEvent).toHaveBeenCalled())
    const snapshot = nextHandlers.onSnapshot.mock.calls[
      nextHandlers.onSnapshot.mock.calls.length - 1
    ]?.[0] as LiveSessionSnapshot | undefined
    expect(snapshot?.last_error).toEqual({
      message: "model refused",
      code: "turn_failed_refusal",
      details: "content filter",
    })
    expect(nextHandlers.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "model refused",
        code: "turn_failed_refusal",
        details: "content filter",
      })
    )
    stream.destroy()
  })
})
