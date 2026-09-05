import { render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LANGUAGE_SETTINGS_STORAGE_KEY } from "@/lib/i18n"

const apiMocks = vi.hoisted(() => ({
  getSystemLanguageSettings: vi.fn(),
}))

vi.mock("@/lib/api", () => ({
  getSystemLanguageSettings: apiMocks.getSystemLanguageSettings,
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}))

vi.mock("next-intl", () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}))

import { AppI18nProvider, useAppI18n } from "./i18n-provider"

function SettingsProbe() {
  const { languageSettings, languageSettingsLoaded } = useAppI18n()
  return (
    <div data-testid="settings">
      {languageSettingsLoaded
        ? `${languageSettings.mode}:${languageSettings.language}`
        : "loading"}
    </div>
  )
}

describe("AppI18nProvider web bootstrap", () => {
  beforeEach(() => {
    localStorage.clear()
    apiMocks.getSystemLanguageSettings.mockReset()
    apiMocks.getSystemLanguageSettings.mockResolvedValue({
      mode: "system",
      language: "en",
    })
  })

  it("uses local defaults before authentication without a backend request", async () => {
    render(
      <AppI18nProvider initialLocale="en" initialMessages={{}}>
        <SettingsProbe />
      </AppI18nProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("settings")).toHaveTextContent("system:en")
    )
    expect(apiMocks.getSystemLanguageSettings).not.toHaveBeenCalled()
  })

  it("restores persisted settings before authentication", async () => {
    localStorage.setItem(
      LANGUAGE_SETTINGS_STORAGE_KEY,
      JSON.stringify({ mode: "manual", language: "zh_cn" })
    )

    render(
      <AppI18nProvider initialLocale="zh-CN" initialMessages={{}}>
        <SettingsProbe />
      </AppI18nProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("settings")).toHaveTextContent("manual:zh_cn")
    )
    expect(apiMocks.getSystemLanguageSettings).not.toHaveBeenCalled()
  })

  it("uses the configured transport after authentication", async () => {
    localStorage.setItem("codeg_token", "admin-token")

    render(
      <AppI18nProvider initialLocale="en" initialMessages={{}}>
        <SettingsProbe />
      </AppI18nProvider>
    )

    await waitFor(() =>
      expect(screen.getByTestId("settings")).toHaveTextContent("system:en")
    )
    expect(apiMocks.getSystemLanguageSettings).toHaveBeenCalledOnce()
  })
})
