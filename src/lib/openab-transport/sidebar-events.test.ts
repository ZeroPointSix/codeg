import { describe, expect, it, vi } from "vitest"
import type { ConversationChange, DbConversationSummary } from "@/lib/types"
import { OpenABTransport } from "./index"

it("opens a real same-origin settings route without an OpenAB server command", async () => {
  const fetchImpl = vi.fn() as unknown as typeof fetch
  const transport = new OpenABTransport({
    baseUrl: "https://openab.test",
    token: "fixture",
    profileId: "test",
    storage: null,
    fetchImpl,
  })
  expect(
    await transport.call("open_settings_window", { locale: "zh-CN" })
  ).toEqual({ path: "/settings/appearance?locale=zh-CN" })
  expect(
    await transport.call("open_settings_window", {
      section: "https://untrusted.example",
    })
  ).toEqual({ path: "/settings/appearance" })
  expect(fetchImpl).not.toHaveBeenCalled()
  transport.destroy()
})

describe("OpenAB per-session sidebar status", () => {
  it("updates only the affected row even when it has no attached conversation", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
    const records = ["admin:a", "admin:b"].map((session_id) => ({
      session_id,
      status: "idle",
      source: { platform: "admin", thread_id: session_id },
      created_at: "2026-09-08",
      updated_at: "2026-09-08",
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/events")
        ? new Response(body)
        : new Response(JSON.stringify(records))
    ) as unknown as typeof fetch
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
      expect(rows.map((row) => row.status)).toEqual([
        "pending_review",
        "pending_review",
      ])
      const changes: ConversationChange[] = []
      const unsubscribe = await transport.subscribe<ConversationChange>(
        "conversation://changed",
        (event) => changes.push(event)
      )
      const send = (status: string, sequence: number) =>
        controller.enqueue(
          new TextEncoder().encode(
            "id: gen:" +
              sequence +
              "\nevent: status_changed\ndata: " +
              JSON.stringify({ snapshot: { session_id: "admin:b", status } }) +
              "\n\n"
          )
        )
      send("running", 1)
      await vi.waitFor(() =>
        expect(changes).toEqual([
          { kind: "status", id: rows[1].id, status: "in_progress" },
        ])
      )
      send("idle", 2)
      await vi.waitFor(() => expect(changes).toHaveLength(2))
      expect(changes[1]).toEqual({
        kind: "status",
        id: rows[1].id,
        status: "pending_review",
      })
      unsubscribe()
      send("running", 3)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(changes).toHaveLength(2)
    } finally {
      transport.destroy()
    }
  })
})
