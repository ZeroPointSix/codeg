import type { LiveSessionSnapshot } from "@/lib/types"
import type { OpenABSseEvent } from "./types"
import { OpenABEventStream, parseSseChunk } from "./event-stream"

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

  it("rehydrates every attached session after a cursor reset", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const loadSnapshot = vi.fn(
      async (sessionId: string, eventSeq = 7) =>
        ({
          connection_id: sessionId,
          event_seq: eventSeq,
        }) as LiveSessionSnapshot
    )
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const handlers = {
      onSnapshot: vi.fn(),
      onReplay: vi.fn(),
      onEvent: vi.fn(),
      onDetached: vi.fn(),
    }

    stream.attach("opaque/session:1", {}, handlers)
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1))

    listener({ id: "generation-b:1", event: "cursor_reset", data: {} })

    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(2))
    expect(loadSnapshot).toHaveBeenLastCalledWith("opaque/session:1", undefined)
  })

  it("hydrates through the event sequence before emitting lifecycle events", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const loadSnapshot = vi.fn(
      async (sessionId: string, eventSeq = 7) =>
        ({
          connection_id: sessionId,
          event_seq: eventSeq,
        }) as LiveSessionSnapshot
    )
    const stream = new OpenABEventStream({
      loadSnapshot,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const handlers = {
      onSnapshot: vi.fn(),
      onReplay: vi.fn(),
      onEvent: vi.fn(),
      onDetached: vi.fn(),
    }

    stream.attach("opaque/session:1", {}, handlers)
    await vi.waitFor(() => expect(loadSnapshot).toHaveBeenCalledTimes(1))

    listener({
      id: "generation-a:42",
      event: "status_changed",
      data: {
        snapshot: { session_id: "opaque/session:1", status: "idle" },
      },
    })

    await vi.waitFor(() => expect(handlers.onEvent).toHaveBeenCalledTimes(1))
    expect(loadSnapshot).toHaveBeenLastCalledWith("opaque/session:1", 41)
    expect(handlers.onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        seq: 42,
        connection_id: "opaque/session:1",
        type: "turn_complete",
      })
    )
  })
})
