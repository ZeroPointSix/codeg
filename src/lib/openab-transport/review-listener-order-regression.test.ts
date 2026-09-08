import { describe, expect, it, vi } from "vitest"
import type { ConversationChange, DbConversationSummary } from "@/lib/types"
import { OpenABTransport } from "./index"

const SESSION_ID = "admin:open"

function sessionRecord(status: string) {
  return {
    session_id: SESSION_ID,
    agent: "codex",
    source: { platform: "admin", thread_id: "open" },
    workdir: "/workspace",
    profile_id: "test",
    profile_name: "Codex",
    profile_status: "active",
    model: "gpt-5",
    reasoning_effort: "medium",
    metadata_source: "runtime",
    status,
    created_at: "2026-09-08T00:00:00Z",
    updated_at: "2026-09-08T00:00:01Z",
  }
}

function transcriptRecord() {
  return {
    session_id: SESSION_ID,
    entries: [],
    overflowed: false,
    oldest_sequence: 0,
    next_sequence: 1,
    stream_generation: "g",
    stream_next_sequence: 1,
  }
}

describe("OpenAB listener order", () => {
  it("keeps an attached session cancelled after independent exited", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/events")) return new Response(body)
      if (url.endsWith("/transcript")) {
        return new Response(JSON.stringify(transcriptRecord()))
      }
      if (url.endsWith("/sessions")) {
        return new Response(JSON.stringify([sessionRecord("running")]))
      }
      return new Response(JSON.stringify(sessionRecord("running")))
    }) as unknown as typeof fetch
    const transport = new OpenABTransport({
      baseUrl: "https://openab.test",
      token: "fixture",
      profileId: "test",
      storage: null,
      fetchImpl,
    })
    try {
      const rows = await transport.call<DbConversationSummary[]>(
        "list_all_conversations"
      )
      expect(rows[0].status).toBe("in_progress")
      const changes: ConversationChange[] = []
      const unsubscribe = await transport.subscribe<ConversationChange>(
        "conversation://changed",
        (event) => changes.push(event)
      )
      const handlers = {
        onSnapshot: vi.fn(),
        onReplay: vi.fn(),
        onEvent: vi.fn(),
        onDetached: vi.fn(),
      }
      transport.eventStream().attach(SESSION_ID, {}, handlers)
      await vi.waitFor(() => expect(handlers.onSnapshot).toHaveBeenCalled())
      controller.enqueue(
        new TextEncoder().encode(
          "id: gen:9\nevent: exited\ndata: " +
            JSON.stringify({ session_id: SESSION_ID }) +
            "\n\n"
        )
      )
      await vi.waitFor(() =>
        expect(changes[changes.length - 1]).toEqual({
          kind: "status",
          id: rows[0].id,
          status: "cancelled",
        })
      )
      expect(
        changes.some(
          (change) =>
            change.kind === "status" && change.status === "pending_review"
        )
      ).toBe(false)
      unsubscribe()
    } finally {
      transport.destroy()
    }
  })
})
