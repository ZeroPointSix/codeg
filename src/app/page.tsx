"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { isDesktop } from "@/lib/platform"
import { OPENAB_BASE_URL_KEY } from "@/components/providers/openab-transport-provider"

export default function Page() {
  const router = useRouter()
  useEffect(() => {
    if (isDesktop()) {
      router.replace("/workspace")
      return
    }
    const token = localStorage.getItem("codeg_token")
    if (!token) {
      router.replace("/login")
      return
    }
    const baseUrl = (
      localStorage.getItem(OPENAB_BASE_URL_KEY) || window.location.origin
    ).replace(/\/+$/, "")
    fetch(`${baseUrl}/api/v1/sessions`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    })
      .then((res) => {
        if (res.status === 401) {
          localStorage.removeItem("codeg_token")
          router.replace("/login")
          return
        }
        router.replace("/workspace")
      })
      .catch(() => router.replace("/workspace"))
  }, [router])
  return null
}
