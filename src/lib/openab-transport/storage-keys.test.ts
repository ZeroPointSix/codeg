import { describe, expect, it } from "vitest"
import {
  openABConnectionScope,
  openABIdentityStorageKey,
  openABOpenedTabsStorageKey,
} from "./storage-keys"

describe("openAB storage keys", () => {
  it("treats trailing slashes as the same OpenAB target", () => {
    expect(openABConnectionScope("https://openab.test/", "codex-default")).toBe(
      openABConnectionScope("https://openab.test", "codex-default")
    )
  })

  it("keeps identity and tab keys distinct across hosts and profiles", () => {
    const alpha = openABIdentityStorageKey(
      "https://alpha.test",
      "codex-default"
    )
    const beta = openABIdentityStorageKey("https://beta.test", "codex-default")
    const otherProfile = openABOpenedTabsStorageKey(
      "https://alpha.test",
      "claude-default"
    )

    expect(alpha).not.toBe(beta)
    expect(alpha).not.toBe(
      openABOpenedTabsStorageKey("https://alpha.test", "codex-default")
    )
    expect(otherProfile).not.toBe(
      openABOpenedTabsStorageKey("https://alpha.test", "codex-default")
    )
  })
})
