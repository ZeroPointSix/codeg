"use client"

import { useEffect, useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { usePathname, useRouter } from "next/navigation"
import { isDesktop } from "@/lib/platform"
import { clearOpenABTransport, configureOpenABTransport } from "@/lib/transport"

export const OPENAB_BASE_URL_KEY = "openab_base_url"
export const OPENAB_PROFILE_ID_KEY = "openab_profile_id"
export const OPENAB_DEFAULT_PROFILE_ID = "codex-default"

export function getOpenABBaseUrl(): string {
  const saved = localStorage.getItem(OPENAB_BASE_URL_KEY)?.trim()
  return (saved || window.location.origin).replace(/\/+$/, "")
}

export function OpenABTransportProvider({ children }: { children: ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [readyPathname, setReadyPathname] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const markReady = () => {
      queueMicrotask(() => {
        if (mounted) setReadyPathname(pathname)
      })
    }

    if (isDesktop()) {
      markReady()
      return () => {
        mounted = false
      }
    }

    const token = localStorage.getItem("codeg_token")
    if (!token) {
      if (
        pathname.startsWith("/workspace") ||
        pathname.startsWith("/settings")
      ) {
        router.replace("/login")
      } else {
        markReady()
      }
      return () => {
        mounted = false
      }
    }

    configureOpenABTransport({
      baseUrl: getOpenABBaseUrl(),
      token,
      profileId:
        localStorage.getItem(OPENAB_PROFILE_ID_KEY)?.trim() ||
        OPENAB_DEFAULT_PROFILE_ID,
      onUnauthorized: () => {
        localStorage.removeItem("codeg_token")
        clearOpenABTransport()
        router.replace("/login")
      },
    })
    markReady()

    return () => {
      mounted = false
      clearOpenABTransport()
    }
  }, [pathname, router])

  if (readyPathname !== pathname) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Connecting to OpenAB
      </div>
    )
  }

  return children
}
