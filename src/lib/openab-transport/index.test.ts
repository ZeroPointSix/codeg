import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  DbConversationDetail,
  DbConversationSummary,
  LiveSessionSnapshot,
} from "@/lib/types"
import { OpenABEventStream, parseSseChunk } from "./event-stream"
import { OpenABTransport } from "./index"
import type {
  OpenABSessionSnapshot,
  OpenABSseEvent,
  OpenABTranscriptSnapshot,
} from "./types"

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

const session = (
  sessionId = "admin:fixture-session"
): OpenABSessionSnapshot => ({
  session_id: sessionId,
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

const transcript = (
  sessionId = "admin:fixture-session"
): OpenABTranscriptSnapshot => ({
  session_id: sessionId,
  entries: [
    {
      entry_id: "entry-1",
      sequence: 1,
      role: "user",
      content: "Run the tests",
      status: "completed",
    },
    {
      entry_id: "entry-2",
      sequence: 2,
      role: "assistant",
      content: "Done",
      status: "completed",
    },
  ],
  overflowed: false,
  oldest_sequence: 1,
  next_sequence: 3,
  stream_generation: "fixture-generation",
  stream_next_sequence: 7,
})

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe("OpenABTransport", () => {
  it("keeps opaque session IDs in external_id and persists local numeric IDs", async () => {
    const storage = new MemoryStorage()
    const firstFetch = vi.fn(async () =>
      json([session()])
    ) as unknown as typeof fetch
    const first = new OpenABTransport({
      baseUrl: "https://openab.test",
      token: "admin-token",
      profileId: "codex-default",
      fetchImpl: firstFetch,
      storage,
    })

    const initial = await first.call<DbConversationSummary[]>(
      "list_all_conversations"
    )
    expect(initial[0].id).toBeTypeOf("number")
    expect(initial[0].external_id).toBe("admin:fixture-session")
    const stableId = initial[0].id
    first.destroy()

    const secondFetch = vi.fn(async () =>
      json([session("admin:new-session"), session()])
    ) as unknown as typeof fetch
    const second = new OpenABTransport({
      baseUrl: "https://openab.test",
      token: "admin-token",
      profileId: "codex-default",
      fetchImpl: secondFetch,
      storage,
    })
    const restored = await second.call<DbConversationSummary[]>(
      "list_all_conversations"
    )

    expect(
      restored.find((item) => item.external_id === "admin:fixture-session")?.id
    ).toBe(stableId)
    expect(new Set(restored.map((item) => item.id)).size).toBe(2)
    second.destroy()
  })

  it("uses only the seven REST paths with Bearer auth and encoded session IDs", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init = {}) => {
      const url = String(input)
      calls.push({ url, init })
      const method = init.method ?? "GET"
      if (url.endsWith("/api/v1/sessions") && method === "POST") {
        return json(session(), 201)
      }
      if (url.endsWith("/transcript")) return json(transcript())
      if (url.endsWith("/messages")) {
        return json({ accepted: true, session_id: session().session_id }, 202)
      }
      if (url.endsWith("/cancel")) return new Response(null, { status: 204 })
      return json(session())
    }) as unknown as typeof fetch
    const transport = new OpenABTransport({
      baseUrl: "https://openab.test/",
      token: "admin-token",
      profileId: "codex-default",
      fetchImpl,
      storage: new MemoryStorage(),
    })

    const connectionId = await transport.call<string>("acp_connect")
    const conversationId = await transport.call<number>("create_conversation")
    const detail = await transport.call<DbConversationDetail>(
      "get_folder_conversation",
      { conversationId }
    )
    await transport.call<DbConversationDetail>("get_folder_conversation", {
      conversationId: "1",
    })
    await transport.call("acp_prompt", {
      connectionId,
      blocks: [{ type: "text", text: "  Run the tests  " }],
    })
    await transport.call("acp_cancel", { connectionId })

    expect(connectionId).toBe("admin:fixture-session")
    expect(conversationId).toBeTypeOf("number")
    expect(detail.summary.external_id).toBe(connectionId)
    expect(calls.map((call) => call.url)).toContain(
      "https://openab.test/api/v1/sessions/admin%3Afixture-session/transcript"
    )
    expect(calls.map((call) => call.url)).toContain(
      "https://openab.test/api/v1/sessions/1/transcript"
    )
    const message = calls.find((call) => call.url.endsWith("/messages"))
    expect(message?.init.body).toBe(JSON.stringify({ text: "Run the tests" }))
    const cancel = calls.find((call) => call.url.endsWith("/cancel"))
    expect(cancel?.init.body).toBeUndefined()
    for (const call of calls) {
      expect(new Headers(call.init.headers).get("Authorization")).toBe(
        "Bearer admin-token"
      )
      expect(call.url).not.toContain("admin-token")
    }
    transport.destroy()
  })

  it("clears authentication through the unauthorized callback", async () => {
    const onUnauthorized = vi.fn()
    const transport = new OpenABTransport({
      baseUrl: "https://openab.test",
      token: "bad-token",
      profileId: "codex-default",
      onUnauthorized,
      fetchImpl: vi.fn(async () =>
        json({ error: "invalid or missing admin token" }, 401)
      ) as unknown as typeof fetch,
      storage: new MemoryStorage(),
    })

    await expect(
      transport.call("list_all_conversations")
    ).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).toHaveBeenCalledOnce()
    transport.destroy()
  })
})

describe("OpenAB SSE", () => {
  it("parses split frames, multiline data, and generation-qualified IDs", () => {
    const first = parseSseChunk(
      "",
      'id: fixture-generation:4\nevent: transcript\ndata: {"sequence":4,'
    )
    expect(first.events).toEqual([])

    const second = parseSseChunk(
      first.rest,
      '"session_id":"admin:fixture-session"}\n\n'
    )
    expect(second.rest).toBe("")
    expect(second.events).toEqual([
      {
        id: "fixture-generation:4",
        event: "transcript",
        data: { sequence: 4, session_id: "admin:fixture-session" },
      },
    ])
  })

  it("refetches global and selected state after a cursor reset", async () => {
    let listener: (event: OpenABSseEvent) => void = () => {}
    const snapshot = { event_seq: 7 } as LiveSessionSnapshot
    const loadSnapshot = vi.fn(async () => snapshot)
    const recover = vi.fn(async () => {})
    const stream = new OpenABEventStream({
      loadSnapshot,
      recover,
      subscribe: (next) => {
        listener = next
        return () => {}
      },
    })
    const onSnapshot = vi.fn()
    const subscription = stream.attach(
      "admin:fixture-session",
      { sinceSeq: 0 },
      {
        onSnapshot,
        onReplay: vi.fn(),
        onEvent: vi.fn(),
        onDetached: vi.fn(),
      }
    )
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledOnce())

    listener({
      id: "new-generation:1",
      event: "cursor_reset",
      data: { sequence: 1 },
    })
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())
    expect(loadSnapshot).toHaveBeenCalledTimes(2)

    subscription.detach()
    stream.destroy()
  })
})
