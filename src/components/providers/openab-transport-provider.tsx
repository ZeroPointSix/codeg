"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { isDesktop } from "@/lib/platform"
import {
  clearOpenABTransport,
  configureOpenABTransport,
} from "@/lib/transport"

export const OPENAB_BASE_URL_KEY = "openab_base_url"
export const OPENAB_PROFILE_ID_KEY = "openab_profile_id"
export const OPENAB_DEFAULT_PROFILE_ID = "codex-default"

export function getOpenABBaseUrl(): string {
  const saved = localStorage.getItem(OPENAB_BASE_URL_KEY)?.trim()
  return (saved || window.location.origin).replace(/\/+$/, "")
}

export function OpenABTransportProvider({
  children,
}: {
  children: ReactNode
}) {
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (isDesktop()) {
      setReady(true)
      return
    }
    const token = localStorage.getItem("codeg_token")
    if (!token) {
      setReady(true)
      return
    }
    configureOpenABTransport({
      baseUrl: getOpenABBaseUrl(),
      token,
      profileId:
        localStorage.getItem(OPENAB_PROFILE_ID_KEY)?.trim() ||
        OPENAB_DEFAULT_PROFILE_ID,
      onUnauthorized: () => {
        localStorage.removeItem("codeg_token")
        router.replace("/login")
      },
    })
    setReady(true)
    return clearOpenABTransport
  }, [router])

  return ready ? children : null
}
