import { render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const nav = vi.hoisted(() => ({
  pathname: "/workspace",
  replace: vi.fn(),
}))

const transportMocks = vi.hoisted(() => ({
  configureOpenABTransport: vi.fn(),
  clearOpenABTransport: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => nav.pathname,
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
}))

vi.mock("@/lib/transport", () => ({
  configureOpenABTransport: transportMocks.configureOpenABTransport,
  clearOpenABTransport: transportMocks.clearOpenABTransport,
}))

import { OpenABTransportProvider } from "./openab-transport-provider"

describe("OpenABTransportProvider", () => {
  beforeEach(() => {
    localStorage.clear()
    nav.pathname = "/workspace"
    nav.replace.mockReset()
    transportMocks.configureOpenABTransport.mockReset()
    transportMocks.clearOpenABTransport.mockReset()
  })

  it("blocks the workspace tree and redirects when no token is present", async () => {
    render(
      <OpenABTransportProvider>
        <div data-testid="workspace-child">workspace</div>
      </OpenABTransportProvider>
    )

    expect(screen.getByText("Connecting to OpenAB")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-child")).not.toBeInTheDocument()
    await waitFor(() => expect(nav.replace).toHaveBeenCalledWith("/login"))
    expect(transportMocks.configureOpenABTransport).not.toHaveBeenCalled()
  })

  it("configures OpenAB transport before rendering the workspace", async () => {
    localStorage.setItem("codeg_token", "admin-token")
    render(
      <OpenABTransportProvider>
        <div data-testid="workspace-child">workspace</div>
      </OpenABTransportProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("workspace-child")).toBeInTheDocument()
    )
    expect(transportMocks.configureOpenABTransport).toHaveBeenCalledWith(
      expect.objectContaining({ token: "admin-token" })
    )
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it("does not intercept the login page when no token is present", async () => {
    nav.pathname = "/login"
    render(
      <OpenABTransportProvider>
        <div data-testid="login-child">login</div>
      </OpenABTransportProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("login-child")).toBeInTheDocument()
    )
    expect(nav.replace).not.toHaveBeenCalled()
    expect(transportMocks.configureOpenABTransport).not.toHaveBeenCalled()
  })

  it("blocks a new route until its transport is configured", async () => {
    nav.pathname = "/login"
    localStorage.setItem("codeg_token", "admin-token")
    const { rerender } = render(
      <OpenABTransportProvider>
        <div data-testid="login-child">login</div>
      </OpenABTransportProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("login-child")).toBeInTheDocument()
    )
    transportMocks.configureOpenABTransport.mockClear()

    nav.pathname = "/workspace"
    rerender(
      <OpenABTransportProvider>
        <div data-testid="workspace-child">workspace</div>
      </OpenABTransportProvider>
    )

    expect(screen.getByText("Connecting to OpenAB")).toBeInTheDocument()
    expect(screen.queryByTestId("workspace-child")).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("workspace-child")).toBeInTheDocument()
    )
    expect(transportMocks.configureOpenABTransport).toHaveBeenCalledOnce()
  })
})
