import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/transport", () => ({
  isOpenABMode: () => true,
}))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    isOpen: true,
    tabs: [],
    activeTabId: null,
    markTerminalExited: vi.fn(),
  }),
}))

vi.mock("./terminal-tab-bar", () => ({
  TerminalTabBar: () => <div>Terminal controls</div>,
}))

vi.mock("./terminal-view", () => ({
  TerminalView: () => <div>Terminal view</div>,
}))

import { TerminalPanel } from "./terminal-panel"

describe("TerminalPanel", () => {
  it("does not render terminal UI in OpenAB mode", () => {
    render(<TerminalPanel />)

    expect(screen.queryByText("Terminal controls")).not.toBeInTheDocument()
    expect(screen.queryByText("Terminal view")).not.toBeInTheDocument()
  })
})
