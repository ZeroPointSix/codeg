import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getShellTransport: vi.fn(),
  isOpenABMode: vi.fn(() => false),
  isRemoteDesktopMode: vi.fn(() => false),
  detectEnvironment: vi.fn(() => "web" as const),
}))

vi.mock("./detect", () => ({
  detectEnvironment: mocks.detectEnvironment,
}))

vi.mock("./index", () => ({
  getShellTransport: mocks.getShellTransport,
  isOpenABMode: mocks.isOpenABMode,
  isRemoteDesktopMode: mocks.isRemoteDesktopMode,
}))

import { subscribeWebConnection } from "./web-connection-store"

describe("web-connection-store", () => {
  afterEach(() => {
    mocks.getShellTransport.mockReset()
    mocks.isOpenABMode.mockReturnValue(false)
    mocks.isRemoteDesktopMode.mockReturnValue(false)
    mocks.detectEnvironment.mockReturnValue("web")
  })

  it("does not create the legacy web transport while OpenAB mode is active", () => {
    mocks.isOpenABMode.mockReturnValue(true)
    const unsubscribe = subscribeWebConnection(() => {})
    unsubscribe()
    expect(mocks.getShellTransport).not.toHaveBeenCalled()
  })
})
