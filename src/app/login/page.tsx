"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { isDesktop } from "@/lib/platform"
import {
  OPENAB_BASE_URL_KEY,
  OPENAB_DEFAULT_PROFILE_ID,
  OPENAB_PROFILE_ID_KEY,
} from "@/components/providers/openab-transport-provider"

export default function LoginPage() {
  const router = useRouter()
  const t = useTranslations("LoginPage")
  const [baseUrl, setBaseUrl] = useState("")
  const [profileId, setProfileId] = useState(OPENAB_DEFAULT_PROFILE_ID)
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    document.title = t("documentTitle")
    setBaseUrl(
      localStorage.getItem(OPENAB_BASE_URL_KEY) ?? window.location.origin
    )
    setProfileId(
      localStorage.getItem(OPENAB_PROFILE_ID_KEY) ?? OPENAB_DEFAULT_PROFILE_ID
    )
  }, [t])

  if (isDesktop()) {
    router.replace("/workspace")
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    const normalizedBaseUrl = (
      baseUrl.trim() || window.location.origin
    ).replace(/\/+$/, "")
    try {
      const res = await fetch(`${normalizedBaseUrl}/api/v1/sessions`, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
      })

      if (res.ok) {
        localStorage.setItem("codeg_token", token)
        localStorage.setItem(OPENAB_BASE_URL_KEY, normalizedBaseUrl)
        localStorage.setItem(
          OPENAB_PROFILE_ID_KEY,
          profileId.trim() || OPENAB_DEFAULT_PROFILE_ID
        )
        router.replace("/workspace")
      } else if (res.status === 401) {
        setError(t("invalidToken"))
      } else {
        setError(t("connectionFailed", { status: res.status }))
      }
    } catch {
      setError(t("networkError"))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 px-4">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-bold tracking-tight">{t("brand")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="OpenAB URL"
            aria-label="OpenAB URL"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          />
          <input
            type="text"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            placeholder="Profile ID"
            aria-label="Profile ID"
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          />
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t("tokenPlaceholder")}
            autoFocus
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm"
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <button
            type="submit"
            disabled={!token || loading}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ring-offset-background transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {loading ? t("connecting") : t("connect")}
          </button>
        </form>

        <p className="text-center text-xs text-muted-foreground">
          {t("helpText")}
        </p>
      </div>
    </div>
  )
}
