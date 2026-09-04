import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetBackendScopedStores } from "./backend-scoped-store-reset"
import { resetTabStore, useTabStore } from "./tab-store"
import type { OpenedTabsSnapshot } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

const { listOpenedTabs } = await import("@/lib/api")
const mockListOpenedTabs = vi.mocked(listOpenedTabs)

const alphaSnapshot: OpenedTabsSnapshot = {
  version: 3,
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
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  resetTabStore()
  mockListOpenedTabs.mockReset()
})

afterEach(() => {
  resetTabStore()
})

describe("tab store backend-scope reset", () => {
  it("does not restore tabs or mark hydrated when a hung hydrate finishes after reset", async () => {
    let resolveSnap!: (value: OpenedTabsSnapshot) => void
    mockListOpenedTabs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnap = resolve
      })
    )

    const unsub = useTabStore.getState().hydrate()
    resetBackendScopedStores()
    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useTabStore.getState().tabsHydrated).toBe(false)

    resolveSnap(alphaSnapshot)
    await flush()

    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useTabStore.getState().tabsHydrated).toBe(false)
    unsub()
  })

  it("does not queue a stale snapshot from refetchTabs after reset", async () => {
    let resolveSnap!: (value: OpenedTabsSnapshot) => void
    mockListOpenedTabs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnap = resolve
      })
    )

    const pending = useTabStore.getState().refetchTabs()
    resetBackendScopedStores()
    resolveSnap(alphaSnapshot)
    await pending
    await flush()

    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useTabStore.getState().tabsHydrated).toBe(false)

    mockListOpenedTabs.mockResolvedValueOnce({ version: 0, items: [] })
    useTabStore.getState().hydrate()
    await flush()

    expect(useTabStore.getState().rawTabs).toEqual([])
  })
})
