import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetBackendScopedStores } from "@/stores/backend-scoped-store-reset"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useTabStore } from "@/stores/tab-store"
import type { OpenABSessionSnapshot } from "@/lib/openab-transport/types"
import {
  __resetTransportForTests,
  configureOpenABTransport,
  getTransport,
} from "./index"

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

function session(sessionId: string, title: string): OpenABSessionSnapshot {
  return {
    session_id: sessionId,
    agent: "fixture-acp",
    source: { platform: "admin", thread_id: sessionId },
    workdir: "/workspace/project",
    profile_id: "codex-default",
    profile_name: "Codex Default",
    profile_status: "active",
    model: "gpt-5",
    reasoning_effort: "high",
    metadata_source: "acp",
    status: "idle",
    created_at: "2026-09-04T00:00:00Z",
    updated_at: "2026-09-04T00:00:08Z",
    title,
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve: (value: T) => resolve(value) }
}

beforeEach(() => {
  __resetTransportForTests()
  resetBackendScopedStores()
})

afterEach(() => {
  __resetTransportForTests()
  resetBackendScopedStores()
})

describe("OpenAB target switch stale REST", () => {
  it("does not restore Alpha sessions, tabs, or errors when a hung Alpha list finishes after switching to Beta", async () => {
    const hungAlphaSessions = deferred<Response>()
    const storage = new MemoryStorage()
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "https://alpha.test/api/v1/sessions") {
        return hungAlphaSessions.promise
      }
      if (url === "https://beta.test/api/v1/sessions") {
        return json([session("1", "Beta session")])
      }
      return json([])
    }) as unknown as typeof fetch

    configureOpenABTransport({
      baseUrl: "https://alpha.test",
      token: "alpha-token",
      profileId: "codex-default",
      fetchImpl,
      storage,
    })

    await getTransport().call("save_opened_tabs", {
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

    const alphaRefresh = useAppWorkspaceStore.getState().refreshConversations()
    const unsub = useTabStore.getState().hydrate()
    useConversationRuntimeStore.getState().actions.fetchDetail(1)

    configureOpenABTransport({
      baseUrl: "https://beta.test",
      token: "beta-token",
      profileId: "codex-default",
      fetchImpl,
      storage,
    })

    hungAlphaSessions.resolve(json([session("1", "Alpha session")]))
    await alphaRefresh
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const workspace = useAppWorkspaceStore.getState()
    expect(workspace.conversations).toEqual([])
    expect(workspace.conversationsError).toBeNull()
    expect(workspace.conversationsLoading).toBe(true)
    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useTabStore.getState().tabsHydrated).toBe(false)
    expect(useConversationRuntimeStore.getState().byConversationId.size).toBe(0)

    await useAppWorkspaceStore.getState().refreshConversations()
    expect(
      useAppWorkspaceStore.getState().conversations.map((c) => c.title)
    ).toEqual(["Beta session"])
    expect(useAppWorkspaceStore.getState().conversationsError).toBeNull()

    unsub()
  })
})
