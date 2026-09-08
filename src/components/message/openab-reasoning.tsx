"use client"

import { memo, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { hasMeaningfulThinking } from "@/lib/openab-transport/adapters"

/** Presentation-only clearing: the authoritative remote transcript is untouched. */
export const OpenABReasoning = memo(function OpenABReasoning({
  content,
  isStreaming,
}: {
  content: string
  isStreaming: boolean
}) {
  const t = useTranslations("Folder.chat.reasoning")
  const [cleared, setCleared] = useState(false)
  const [buffered, setBuffered] = useState(content)
  const latest = useRef(content)
  useEffect(() => {
    latest.current = content
  }, [content])
  useEffect(() => {
    if (!isStreaming || cleared) return
    const timer = setInterval(() => setBuffered(latest.current), 500)
    return () => clearInterval(timer)
  }, [isStreaming, cleared])
  // Flush the final text immediately, without another effect-driven render.
  const visible = isStreaming ? buffered : content
  if (cleared || !hasMeaningfulThinking(visible)) return null
  return (
    <Reasoning isStreaming={isStreaming} defaultOpen={false}>
      <div className="flex items-center gap-2">
        <ReasoningTrigger className="min-w-0 flex-1" />
        <button
          type="button"
          className="shrink-0 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setCleared(true)}
          title={t("clearHint")}
        >
          {t("clear")}
        </button>
      </div>
      <ReasoningContent>{visible}</ReasoningContent>
    </Reasoning>
  )
})
