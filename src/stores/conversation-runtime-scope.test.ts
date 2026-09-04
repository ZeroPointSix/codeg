import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetBackendScopedStores } from "./backend-scoped-store-reset"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "./conversation-runtime-store"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
  getFolderConversationTurns: vi.fn(),
}))

const { getFolderConversation } = await import("@/lib/api")
const mockGet = vi.mocked(getFolderConversation)

const CID = 1

function userTurn(id: string, text: string): MessageTurn {
  return { id, role: "user", blocks: [{ type: "text", text }], timestamp: "" }
}

function detail(title: string): DbConversationDetail {
  const turns = [userTurn("u", title)]
  return {
    summary: {
      id: CID,
      folder_id: 954_000_000,
      agent_type: "openab",
      title,
      title_locked: false,
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: "1",
      message_count: turns.length,
      child_count: 0,
      created_at: "2026-09-04T00:00:00.000Z",
      updated_at: "2026-09-04T00:00:00.000Z",
      pinned_at: null,
    },
    turns,
    session_stats: null,
    transcript_watermark: null,
    in_flight_user_turn_id: null,
  }
}

function session() {
  return useConversationRuntimeStore.getState().byConversationId.get(CID)
}

function actions() {
  return useConversationRuntimeStore.getState().actions
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetConversationRuntimeStore()
  mockGet.mockReset()
})

afterEach(() => {
  resetConversationRuntimeStore()
})

describe("conversation runtime backend-scope reset", () => {
  it("does not rematch a pre-reset fetch when the new target bumps generation to 1", async () => {
    let resolveAlpha!: (value: DbConversationDetail) => void
    let resolveBeta!: (value: DbConversationDetail) => void
    mockGet
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveAlpha = resolve
        })
      )
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveBeta = resolve
        })
      )

    actions().fetchDetail(CID)
    expect(session()?.detailLoading).toBe(true)

    resetBackendScopedStores()
    expect(session()).toBeUndefined()

    actions().fetchDetail(CID)
    expect(session()?.detailLoading).toBe(true)
    expect(session()?.detail).toBeNull()

    resolveAlpha(detail("Alpha session"))
    await flush()

    expect(session()?.detail).toBeNull()
    expect(session()?.detailLoading).toBe(true)
    expect(session()?.detailError).toBeNull()

    resolveBeta(detail("Beta session"))
    await flush()

    expect(session()?.detail?.summary.title).toBe("Beta session")
    expect(session()?.detailLoading).toBe(false)
  })
})
