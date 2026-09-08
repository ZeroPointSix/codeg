import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import messages from "@/i18n/messages/en.json"

vi.mock("@/components/ai-elements/reasoning", () => ({
  Reasoning: ({
    children,
    defaultOpen,
  }: {
    children: ReactNode
    defaultOpen?: boolean
  }) => (
    <section data-testid="reasoning" data-default-open={String(defaultOpen)}>
      {children}
    </section>
  ),
  ReasoningTrigger: () => <button>Toggle reasoning</button>,
  ReasoningContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
import { OpenABReasoning } from "./openab-reasoning"
const tree = (content: string, isStreaming = true) => (
  <NextIntlClientProvider locale="en" messages={messages}>
    <OpenABReasoning content={content} isStreaming={isStreaming} />
  </NextIntlClientProvider>
)
afterEach(() => vi.useRealTimers())
describe("OpenAB reasoning presentation", () => {
  it.each(["", ":", "...", "\uFF1A"])(
    "omits redacted placeholder %j",
    (content) => {
      render(tree(content))
      expect(screen.queryByTestId("reasoning")).not.toBeInTheDocument()
    }
  )
  it("defaults closed and batches streaming text instead of rendering every delta", () => {
    vi.useFakeTimers()
    const { rerender } = render(tree("First phrase"))
    expect(screen.getByTestId("reasoning")).toHaveAttribute(
      "data-default-open",
      "false"
    )
    rerender(tree("First phrase with a delta"))
    expect(
      screen.queryByText("First phrase with a delta")
    ).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByText("First phrase with a delta")).toBeInTheDocument()
    rerender(tree("Final reasoning", false))
    expect(screen.getByText("Final reasoning")).toBeInTheDocument()
  })
  it("does not bring cleared content back on the next delta", () => {
    const { rerender } = render(tree("Reasoning to hide"))
    fireEvent.click(screen.getByRole("button", { name: "Clear display" }))
    rerender(tree("Reasoning to hide with more output"))
    expect(screen.queryByTestId("reasoning")).not.toBeInTheDocument()
  })
})
