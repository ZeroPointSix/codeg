import { afterEach, describe, expect, it, vi } from "vitest"
import type { ConversationChange, EventEnvelope } from "@/lib/types"
import { OpenABEventStream } from "./event-stream"
import { OpenABTransport } from "./index"
import type { OpenABSseEvent } from "./types"
import type { LiveSessionSnapshot } from "@/lib/types"

const ID = "admin:review/session"
const streams = new Set<OpenABEventStream>()

function snapshot(): LiveSessionSnapshot {
  return {
    connection_id: ID,
    conversation_id: null,
    folder_id: null,
    status: "prompting",
    external_id: ID,
    live_message: {
      id: "assistant-1",
      role: "assistant",
      content: [{ kind: "text", text: "hello" }],
      started_at: "2026-09-08T00:00:00Z",
    },
    active_tool_calls: [],
    pending_permission: null,
    modes: null,
    current_mode: null,
    config_options: null,
    prompt_capabilities: null,
    usage: null,
    fork_supported: false,
    available_commands: [],
    selectors_ready: true,
    last_error: null,
    event_seq: 0,
  }
}

function streamHarness() {
  let source: (event: OpenABSseEvent) => void = () => {}
  const handlers = {
    onSnapshot: vi.fn(),
    onReplay: vi.fn(),
    onEvent: vi.fn(),
    onDetached: vi.fn(),
  }
  const stream = new OpenABEventStream({
    loadSnapshot: vi.fn(async () => snapshot()),
    subscribe: (fn) => {
      source = fn
      return vi.fn()
    },
  })
  streams.add(stream)
  return {
    handlers,
    attach: () => stream.attach(ID, {}, handlers),
    emit: (event: OpenABSseEvent) => source(event),
    types: () =>
      handlers.onEvent.mock.calls.map(
        (call) => (call[0] as EventEnvelope).type
      ),
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

afterEach(() => {
  for (const stream of streams) stream.destroy()
  streams.clear()
  vi.useRealTimers()
})

describe("OpenAB terminal ACP settlement", () => {
  it("emits turn_complete after a remote error so the live turn can settle", async () => {
    vi.useFakeTimers()
    const h = streamHarness()
    h.attach()
    await flush()
    h.emit({
      id: "g:2",
      event: "error",
      data: { session_id: ID, error: "agent failed" },
    })
    expect(h.types()).toEqual(["error", "turn_complete"])
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].status).not.toBe(
      "prompting"
    )
  })

  it("emits turn_complete after an independent exited event", async () => {
    vi.useFakeTimers()
    const h = streamHarness()
    h.attach()
    await flush()
    h.emit({
      id: "g:3",
      event: "exited",
      data: { session_id: ID },
    })
    expect(h.types()).toEqual(["turn_complete"])
    expect(h.handlers.onSnapshot.mock.lastCall?.[0].status).not.toBe(
      "prompting"
    )
  })

  it("marks an unopened sidebar row cancelled when it receives exited", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/events")
        ? new Response(body)
        : new Response(
            JSON.stringify([
              {
                session_id: "admin:closed",
                status: "running",
                source: { platform: "admin", thread_id: "closed" },
                created_at: "2026-09-08",
                updated_at: "2026-09-08",
              },
            ])
          )
    ) as unknown as typeof fetch
    const transport = new OpenABTransport({
      baseUrl: "https://openab.test",
      token: "fixture",
      profileId: "test",
      storage: null,
      fetchImpl,
    })
    try {
      const rows = await transport.call<{ id: number; status: string }[]>(
        "list_all_conversations"
      )
      expect(rows[0].status).toBe("in_progress")
      const changes: ConversationChange[] = []
      const unsubscribe = await transport.subscribe<ConversationChange>(
        "conversation://changed",
        (event) => changes.push(event)
      )
      controller.enqueue(
        new TextEncoder().encode(
          "id: gen:9\nevent: exited\ndata: " +
            JSON.stringify({ session_id: "admin:closed" }) +
            "\n\n"
        )
      )
      await vi.waitFor(() =>
        expect(changes).toEqual([
          { kind: "status", id: rows[0].id, status: "cancelled" },
        ])
      )
      unsubscribe()
    } finally {
      transport.destroy()
    }
  })
})
