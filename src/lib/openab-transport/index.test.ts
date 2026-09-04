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

  it("isolates mappings and opened tabs per OpenAB target when session_id is 1", async () => {
    const storage = new MemoryStorage()
    storage.setItem(
      "openab_conversation_identities_v1",
      JSON.stringify({
        nextId: 99,
        entries: [{ sessionId: "1", conversationId: 98 }],
      })
    )
    storage.setItem(
      "openab_opened_tabs",
      JSON.stringify({
        version: 7,
        items: [
          {
            id: 1,
            folder_id: 1,
            conversation_id: 98,
            agent_type: "openab",
            position: 0,
            is_active: true,
            is_pinned: false,
          },
        ],
      })
    )
    const fetchFor = () =>
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith("/api/v1/sessions")) return json([session("1")])
        if (url.endsWith("/transcript")) return json(transcript("1"))
        return json(session("1"))
      }) as unknown as typeof fetch

    const alpha = new OpenABTransport({
      baseUrl: "https://alpha.test/",
      token: "alpha-token",
      profileId: "codex-default",
      fetchImpl: fetchFor(),
      storage,
    })
    const alphaList = await alpha.call<DbConversationSummary[]>(
      "list_all_conversations"
    )
    expect(alphaList[0]?.id).toBe(1)
    expect(alphaList[0]?.external_id).toBe("1")
    const saved = await alpha.call<{ accepted: boolean }>("save_opened_tabs", {
      expectedVersion: 0,
      items: [
        {
          id: 1,
          folder_id: 954_000_000,
          conversation_id: 1,
          agent_type: "openab",
          position: 0,
          is_active: true,
          is_pinned: false,
        },
      ],
    })
    expect(saved.accepted).toBe(true)
    alpha.destroy()

    const beta = new OpenABTransport({
      baseUrl: "https://beta.test",
      token: "beta-token",
      profileId: "codex-default",
      fetchImpl: fetchFor(),
      storage,
    })
    const betaList = await beta.call<DbConversationSummary[]>(
      "list_all_conversations"
    )
    expect(betaList[0]?.external_id).toBe("1")
    const betaTabs = await beta.call<{
      items: Array<{ conversation_id: number | null }>
      version: number
    }>("list_opened_tabs")
    expect(betaTabs.version).toBe(0)
    expect(betaTabs.items).toEqual([])
    const betaDetail = await beta.call<DbConversationDetail>(
      "get_folder_conversation",
      { conversationId: 1 }
    )
    expect(betaDetail.summary.external_id).toBe("1")
    beta.destroy()

    const alphaAgain = new OpenABTransport({
      baseUrl: "https://alpha.test",
      token: "alpha-token",
      profileId: "codex-default",
      fetchImpl: fetchFor(),
      storage,
    })
    const restoredAlpha = await alphaAgain.call<DbConversationSummary[]>(
      "list_all_conversations"
    )
    expect(restoredAlpha[0]?.id).toBe(1)
    const alphaTabs = await alphaAgain.call<{
      items: Array<{ conversation_id: number | null }>
      version: number
    }>("list_opened_tabs")
    expect(alphaTabs.version).toBe(1)
    expect(alphaTabs.items[0]?.conversation_id).toBe(1)
    alphaAgain.destroy()

    const otherProfile = new OpenABTransport({
      baseUrl: "https://alpha.test",
      token: "alpha-token",
      profileId: "claude-default",
      fetchImpl: fetchFor(),
      storage,
    })
    const otherTabs = await otherProfile.call<{
      items: unknown[]
      version: number
    }>("list_opened_tabs")
    expect(otherTabs.items).toEqual([])
    otherProfile.destroy()
  })

  it("rejects in-flight REST after destroy even when fetch ignores abort", async () => {
    let release!: (value: Response) => void
    const hung = new Promise<Response>((resolve) => {
      release = resolve
    })
    const transport = new OpenABTransport({
      baseUrl: "https://alpha.test",
      token: "alpha-token",
      profileId: "codex-default",
      fetchImpl: vi.fn(async () => hung) as unknown as typeof fetch,
      storage: new MemoryStorage(),
    })

    const pending = transport.call("list_all_conversations")
    transport.destroy()
    release(json([session("1")]))

    await expect(pending).rejects.toMatchObject({
      code: "aborted",
      message: "OpenAB transport destroyed",
    })
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

  it("does not resolve opaque numeric session IDs through local proxy IDs", async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/api/v1/sessions")) {
        return json([session("admin:other"), session("1")])
      }
      if (url.endsWith("/transcript")) {
        const encoded = url.split("/sessions/")[1]?.split("/")[0] ?? ""
        return json(transcript(decodeURIComponent(encoded)))
      }
      const encoded = url.split("/sessions/")[1] ?? ""
      return json(session(decodeURIComponent(encoded)))
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
    const other = listed.find((item) => item.external_id === "admin:other")
    const opaque = listed.find((item) => item.external_id === "1")
    expect(other?.id).toBe(1)
    expect(opaque?.id).toBe(2)

    await transport.call("get_folder_conversation", { conversationId: 1 })
    await transport.call("get_folder_conversation", { conversationId: "1" })
    await transport.call("get_folder_conversation", { conversationId: 2 })

    expect(calls).toContain(
      "https://openab.test/api/v1/sessions/admin%3Aother/transcript"
    )
    expect(
      calls.filter(
        (url) => url === "https://openab.test/api/v1/sessions/1/transcript"
      )
    ).toHaveLength(2)
    transport.destroy()
  })

  it("notifies reconnect listeners after SSE recovery even if listing fails", async () => {
    const encoder = new TextEncoder()
    let push: ((chunk: string) => void) | undefined
    const eventsBody = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (chunk) => controller.enqueue(encoder.encode(chunk))
      },
    })
    let failList = false
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/events")) {
        return new Response(eventsBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      }
      if (url.endsWith("/api/v1/sessions")) {
        if (failList) {
          return json({ error: "unavailable" }, 500)
        }
        return json([session()])
      }
      if (url.endsWith("/transcript")) return json(transcript())
      return json(session())
    })
    const transport = new OpenABTransport({
      baseUrl: "https://openab.test",
      token: "admin-token",
      profileId: "codex-default",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      storage: new MemoryStorage(),
    })
    const onReconnect = vi.fn()
    transport.onReconnect(onReconnect)
    const onSnapshot = vi.fn()
    const subscription = transport.eventStream().attach(
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
    await vi.waitFor(() =>
      expect(
        fetchImpl.mock.calls.some(([url]) => String(url).endsWith("/events"))
      ).toBe(true)
    )
    failList = true
    push?.('id: gen:1\nevent: cursor_reset\ndata: {"sequence":1}\n\n')

    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(onSnapshot).toHaveBeenCalledTimes(2))

    subscription.detach()
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
