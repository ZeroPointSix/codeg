import { afterEach, describe, expect, it, vi } from "vitest"
import type { DbConversationSummary, LiveSessionSnapshot } from "@/lib/types"
import { OpenABTransport } from "./index"
import type { OpenABSessionSnapshot, OpenABTranscriptSnapshot } from "./types"

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  get length() {
    return this.values.size
  }
  clear() {
    this.values.clear()
  }
  getItem(key: string) {
    return this.values.get(key) ?? null
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }
  removeItem(key: string) {
    this.values.delete(key)
  }
  setItem(key: string, value: string) {
    this.values.set(key, value)
  }
}

const session = (): OpenABSessionSnapshot => ({
  session_id: "admin:fixture-session",
  agent: "fixture-acp",
  source: { platform: "admin", thread_id: "fixture-session" },
  workdir: "/workspace/project",
  profile_id: "codex-default",
  profile_name: "Codex Default",
  profile_status: "active",
  model: "gpt-5",
  reasoning_effort: "high",
  metadata_source: "acp",
  status: "idle",
  created_at: "2026-09-03T00:00:00Z",
  updated_at: "2026-09-03T00:00:08Z",
  title: "Fixture session",
})

const transcript = (): OpenABTranscriptSnapshot => ({
  session_id: "admin:fixture-session",
  entries: [],
  overflowed: false,
  oldest_sequence: 0,
  next_sequence: 1,
  stream_generation: "fixture-generation",
  stream_next_sequence: 1,
})

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("OpenAB workbench mock flow", () => {
  it("lists, creates, attaches, prompts, streams, and cancels without a REST storm", async () => {
    const encoder = new TextEncoder()
    let push: ((chunk: string) => void) | undefined
    const eventsBody = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
      },
    })
    const urls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init = {}) => {
      const url = String(input)
      urls.push(`${init.method ?? "GET"} ${url}`)
      if (url.endsWith("/api/v1/sessions/events")) {
        return new Response(eventsBody, {
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (
        url.endsWith("/api/v1/sessions") &&
        (init.method ?? "GET") === "POST"
      ) {
        return json(session(), 201)
      }
      if (url.endsWith("/api/v1/sessions")) return json([session()])
      if (url.endsWith("/transcript")) return json(transcript())
      if (url.endsWith("/messages")) {
        return json({ accepted: true, session_id: session().session_id }, 202)
      }
      if (url.endsWith("/cancel")) return new Response(null, { status: 204 })
      return json(session())
    }) as unknown as typeof fetch

    const transport = new OpenABTransport({
      baseUrl: "https://openab.test",
      token: "admin-token",
      profileId: "codex-default",
      fetchImpl,
      storage: new MemoryStorage(),
    })

    const listed = await transport.call<DbConversationSummary[]>(
      "list_all_conversations"
    )
    expect(listed[0]?.external_id).toBe("admin:fixture-session")
    expect(listed[0]?.id).toBeTypeOf("number")

    const conversationId = await transport.call<number>("create_conversation")
    expect(conversationId).toBeTypeOf("number")

    const onSnapshot = vi.fn()
    const onEvent = vi.fn()
    const sub = transport.eventStream().attach(
      "admin:fixture-session",
      {},
      {
        onSnapshot,
        onReplay: vi.fn(),
        onEvent,
        onDetached: vi.fn(),
      }
    )
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce())

    await transport.call("acp_prompt", {
      connectionId: "admin:fixture-session",
      blocks: [{ type: "text", text: "Run the tests" }],
    })

    const transcriptGetsBeforeStream = urls.filter((item) =>
      item.includes("/transcript")
    ).length

    for (let sequence = 1; sequence <= 12; sequence += 1) {
      push?.(
        `id: fixture-generation:${sequence}\nevent: transcript\ndata: ${JSON.stringify(
          {
            session_id: "admin:fixture-session",
            sequence,
            entry: {
              entry_id: "assistant-1",
              sequence,
              role: "assistant",
              content: `token-${sequence}`,
              status: "streaming",
            },
          }
        )}\n\n`
      )
    }

    await vi.waitFor(() => {
      const last = onSnapshot.mock.calls[
        onSnapshot.mock.calls.length - 1
      ]?.[0] as LiveSessionSnapshot | undefined
      expect(last?.live_message?.content).toEqual([
        { kind: "text", text: "token-12" },
      ])
    })

    push?.(
      `id: fixture-generation:13\nevent: status_changed\ndata: ${JSON.stringify(
        {
          snapshot: {
            session_id: "admin:fixture-session",
            status: "error",
            last_error: {
              message: "quota exceeded",
              code: "resource_exhausted",
              details: "retry after 60s",
            },
          },
        }
      )}\n\n`
    )

    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          message: "quota exceeded",
          details: "retry after 60s",
        })
      )
    )
    const errorSnap = onSnapshot.mock.calls[
      onSnapshot.mock.calls.length - 1
    ]?.[0] as LiveSessionSnapshot | undefined
    expect(errorSnap?.last_error?.message).toBe("quota exceeded")

    await transport.call("acp_cancel", {
      connectionId: "admin:fixture-session",
    })

    const transcriptGets = urls.filter((item) => item.includes("/transcript"))
    expect(transcriptGets.length).toBe(transcriptGetsBeforeStream)
    expect(urls.some((item) => item.endsWith("/messages"))).toBe(true)
    expect(urls.some((item) => item.endsWith("/cancel"))).toBe(true)

    sub.detach()
    transport.destroy()
  })
})
