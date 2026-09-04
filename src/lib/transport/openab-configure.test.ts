import { beforeEach, describe, expect, it, vi } from "vitest"

const storeReset = vi.hoisted(() => ({ reset: vi.fn() }))

vi.mock("@/stores/backend-scoped-store-reset", () => ({
  resetBackendScopedStores: storeReset.reset,
}))

import {
  __resetTransportForTests,
  clearOpenABTransport,
  configureOpenABTransport,
} from "./index"

describe("configureOpenABTransport", () => {
  beforeEach(() => {
    storeReset.reset.mockReset()
    __resetTransportForTests()
  })

  it("resets backend-scoped stores when the OpenAB target changes", () => {
    configureOpenABTransport({
      baseUrl: "https://alpha.test",
      token: "alpha-token",
      profileId: "codex-default",
      storage: null,
    })
    expect(storeReset.reset).toHaveBeenCalledTimes(1)

    configureOpenABTransport({
      baseUrl: "https://alpha.test",
      token: "alpha-token",
      profileId: "codex-default",
      storage: null,
    })
    expect(storeReset.reset).toHaveBeenCalledTimes(1)

    configureOpenABTransport({
      baseUrl: "https://beta.test",
      token: "beta-token",
      profileId: "codex-default",
      storage: null,
    })
    expect(storeReset.reset).toHaveBeenCalledTimes(2)

    clearOpenABTransport()
    configureOpenABTransport({
      baseUrl: "https://beta.test",
      token: "beta-token",
      profileId: "codex-default",
      storage: null,
    })
    expect(storeReset.reset).toHaveBeenCalledTimes(3)
  })
})
