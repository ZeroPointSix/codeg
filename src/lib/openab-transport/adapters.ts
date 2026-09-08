import type {
  ContentBlock,
  ConversationStatus,
  DbConversationDetail,
  DbConversationSummary,
  LiveMessage,
  LiveSessionSnapshot,
  MessageTurn,
  SessionLastError,
  ToolCallState,
} from "@/lib/types"
import type {
  OpenABSessionSnapshot,
  OpenABSseEvent,
  OpenABToolCall,
  OpenABTranscriptEntry,
  OpenABTranscriptSnapshot,
} from "./types"

export const OPENAB_FOLDER_ID = 954_000_000

/**
 * Linear/OpenAB require the opaque `session_id` to stay canonical on the
 * network and in `external_id` / `connection_id`. Codeg's conversation table,
 * tabs, and runtime stores are typed as numeric `id`s, so this adapter keeps a
 * local integer proxy in `summary.id` / `conversation_id` and never sends that
 * integer to OpenAB as a session id.
 */
export function mapOpenABStatus(status: string): LiveSessionSnapshot["status"] {
  if (["running", "busy", "prompting"].includes(status)) {
    return "prompting"
  }
  if (status === "error" || status === "failed") return "error"
  if (status === "starting") return "connecting"
  if (["idle", "connected", "completed", "cancelled"].includes(status))
    return "connected"
  return "disconnected"
}

/** Idle is resumable, not generating; completed would archive it in Codeg. */
export function mapOpenABConversationStatus(
  status: string
): ConversationStatus {
  if (mapOpenABStatus(status) === "prompting") return "in_progress"
  if (["error", "failed", "cancelled", "exited"].includes(status))
    return "cancelled"
  return "pending_review"
}

/** Redacted/empty reasoning placeholders are not useful content. */
export function hasMeaningfulThinking(text: string): boolean {
  return typeof text === "string" && /[\p{L}\p{N}]/u.test(text)
}

export function mapOpenABLastError(raw: unknown): SessionLastError | null {
  if (raw == null) return null
  if (typeof raw === "string") {
    const message = raw.trim()
    return message ? { message } : null
  }
  if (typeof raw !== "object") return null
  const value = raw as {
    message?: unknown
    code?: unknown
    details?: unknown
    error?: unknown
  }
  const message =
    typeof value.message === "string"
      ? value.message.trim()
      : typeof value.error === "string"
        ? value.error.trim()
        : ""
  if (!message) return null
  return {
    message,
    code: typeof value.code === "string" ? value.code : null,
    details: typeof value.details === "string" ? value.details : null,
  }
}

function ssePayload(event: OpenABSseEvent): Record<string, unknown> | null {
  if (!event.data || typeof event.data !== "object") return null
  return event.data as Record<string, unknown>
}

function transcriptEntryFromPayload(
  payload: Record<string, unknown>
): OpenABTranscriptEntry | null {
  const nested = payload.entry
  const raw =
    nested && typeof nested === "object"
      ? (nested as Record<string, unknown>)
      : payload
  if (typeof raw.entry_id !== "string") return null
  if (typeof raw.sequence !== "number" || !Number.isSafeInteger(raw.sequence)) {
    return null
  }
  if (
    raw.role !== "user" &&
    raw.role !== "assistant" &&
    raw.role !== "system" &&
    raw.role !== "tool"
  ) {
    return null
  }
  return {
    entry_id: raw.entry_id,
    sequence: raw.sequence,
    timestamp: typeof raw.timestamp === "string" ? raw.timestamp : undefined,
    role: raw.role,
    content: typeof raw.content === "string" ? raw.content : "",
    status: typeof raw.status === "string" ? raw.status : "completed",
    tool_call: raw.tool_call as OpenABTranscriptEntry["tool_call"],
    tool_result: raw.tool_result as OpenABTranscriptEntry["tool_result"],
    tool_call_id:
      typeof raw.tool_call_id === "string" ? raw.tool_call_id : undefined,
  }
}

function isAssistantThinking(entry: OpenABTranscriptEntry): boolean {
  return entry.role === "assistant" && entry.status === "thinking"
}

function appendThinkingDelta(
  current: LiveMessage | null,
  entry: OpenABTranscriptEntry
): LiveMessage | null {
  const startedAt =
    current?.started_at ?? entry.timestamp ?? new Date().toISOString()
  const content = current?.content ?? []
  const last = content[content.length - 1]
  if (last?.kind === "thinking") {
    if (!entry.content) return current
    return {
      id: current?.id ?? entry.entry_id,
      role: "assistant",
      started_at: startedAt,
      content: [
        ...content.slice(0, -1),
        { kind: "thinking", text: last.text + entry.content },
      ],
    }
  }
  if (!hasMeaningfulThinking(entry.content)) return current
  return {
    id: current?.id ?? entry.entry_id,
    role: "assistant",
    started_at: startedAt,
    content: [...content, { kind: "thinking", text: entry.content }],
  }
}

function patchSnapshotFromEntry(
  current: LiveSessionSnapshot,
  entry: OpenABTranscriptEntry,
  eventSeq: number
): LiveSessionSnapshot {
  let liveMessage = current.live_message
  let activeToolCalls = current.active_tool_calls
  if (isAssistantThinking(entry)) {
    liveMessage = appendThinkingDelta(liveMessage, entry)
  } else if (entry.role === "assistant" || entry.role === "system") {
    const nextLive = latestLiveMessage([
      entry.status === "completed" && entry.role === "assistant"
        ? { ...entry, status: "streaming" }
        : entry,
    ])
    if (nextLive) {
      const thinking = (liveMessage?.content ?? []).filter(
        (block) => block.kind === "thinking"
      )
      liveMessage = {
        ...nextLive,
        id: nextLive.id,
        started_at: liveMessage?.started_at ?? nextLive.started_at,
        content: [...thinking, ...nextLive.content],
      }
    } else if (liveMessage?.id === entry.entry_id) liveMessage = null
  }
  if (entry.role === "tool") {
    const tool = toToolCallState(entry)
    const rest = activeToolCalls.filter((item) => item.id !== tool.id)
    activeToolCalls =
      tool.status === "pending" || tool.status === "in_progress"
        ? [...rest, tool]
        : rest
  }
  return {
    ...current,
    live_message: current.status === "prompting" ? liveMessage : null,
    active_tool_calls: current.status === "prompting" ? activeToolCalls : [],
    event_seq: eventSeq,
  }
}

/**
 * Apply an SSE frame onto the last live snapshot without REST. Returns null
 * when the frame has no usable payload (caller should coalesce a hydrate).
 */
export function applyOpenABSseToSnapshot(
  current: LiveSessionSnapshot,
  event: OpenABSseEvent,
  eventSeq: number
): LiveSessionSnapshot | null {
  const payload = ssePayload(event)
  if (!payload) return null

  if (
    event.event === "transcript" ||
    event.event === "entry" ||
    event.event === "entry_updated"
  ) {
    const entry = transcriptEntryFromPayload(payload)
    if (!entry) return null
    return patchSnapshotFromEntry(current, entry, eventSeq)
  }

  if (event.event === "status_changed") {
    const snapshot = payload.snapshot
    if (!snapshot || typeof snapshot !== "object") return null
    const fields = snapshot as { status?: unknown; last_error?: unknown }
    const status =
      typeof fields.status === "string"
        ? mapOpenABStatus(fields.status)
        : current.status
    const lastError =
      "last_error" in fields
        ? mapOpenABLastError(fields.last_error)
        : current.last_error
    return {
      ...current,
      status,
      last_error: status === "prompting" ? null : lastError,
      live_message: status === "prompting" ? current.live_message : null,
      active_tool_calls:
        status === "prompting" ? current.active_tool_calls : [],
      event_seq: eventSeq,
    }
  }

  if (event.event === "error") {
    const lastError =
      mapOpenABLastError(payload.last_error) ??
      mapOpenABLastError(payload.error) ??
      mapOpenABLastError(payload)
    return {
      ...current,
      status: "error",
      live_message: null,
      active_tool_calls: [],
      last_error: lastError ?? current.last_error,
      event_seq: eventSeq,
    }
  }

  if (event.event === "exited") {
    return {
      ...current,
      status: "disconnected",
      live_message: null,
      active_tool_calls: [],
      event_seq: eventSeq,
    }
  }

  return null
}

export function toConversationSummary(
  session: OpenABSessionSnapshot,
  conversationId: number,
  messageCount = 0
): DbConversationSummary {
  return {
    id: conversationId,
    folder_id: OPENAB_FOLDER_ID,
    title: session.title ?? session.profile_name ?? session.session_id,
    title_locked: false,
    agent_type: "openab",
    // OpenAB idle sessions remain resumable. Codeg's completed status means the
    // user archived the conversation and hides it from the sidebar by default.
    status: mapOpenABConversationStatus(session.status),
    kind: "chat",
    model: session.model,
    git_branch: null,
    external_id: session.session_id,
    message_count: messageCount,
    child_count: 0,
    created_at: session.created_at,
    updated_at: session.updated_at,
    pinned_at: null,
    parent_id: null,
    parent_tool_use_id: null,
    delegation_call_id: null,
    origin_cwd: null,
  }
}

export function latestTranscriptEntries(
  transcript: OpenABTranscriptSnapshot
): OpenABTranscriptEntry[] {
  const entries = new Map<
    string,
    { firstSequence: number; entry: OpenABTranscriptEntry }
  >()
  for (const entry of transcript.entries) {
    const current = entries.get(entry.entry_id)
    if (!current) {
      entries.set(entry.entry_id, {
        firstSequence: entry.sequence,
        entry,
      })
      continue
    }
    if (entry.sequence >= current.entry.sequence) {
      current.entry = {
        ...current.entry,
        ...entry,
        tool_call: entry.tool_call ?? current.entry.tool_call,
        tool_result: entry.tool_result ?? current.entry.tool_result,
      }
    }
  }
  return [...entries.values()]
    .sort((a, b) => a.firstSequence - b.firstSequence)
    .map((item) => item.entry)
}

function toolText(tool: OpenABToolCall | undefined): string | null {
  if (!tool?.content) return null
  const text = tool.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
  return text || null
}

function normalizeToolStatus(status: string): ToolCallState["status"] {
  if (status === "running" || status === "streaming") return "in_progress"
  if (status === "failed" || status === "error") return "failed"
  if (status === "completed") return "completed"
  return "pending"
}

function entryBlocks(entry: OpenABTranscriptEntry): ContentBlock[] {
  if (entry.role !== "tool") {
    return [
      entry.status === "thinking"
        ? { type: "thinking", text: entry.content }
        : { type: "text", text: entry.content },
    ]
  }
  const tool = entry.tool_result ?? entry.tool_call
  const toolCallId = entry.tool_call_id ?? tool?.toolCallId ?? entry.entry_id
  const title = tool?.title ?? entry.content ?? "Tool"
  const blocks: ContentBlock[] = [
    {
      type: "tool_use",
      tool_use_id: toolCallId,
      tool_name: title,
      input_preview:
        tool?.rawInput === undefined ? null : JSON.stringify(tool.rawInput),
      status: normalizeToolStatus(entry.status),
    },
  ]
  const result = toolText(entry.tool_result ?? tool)
  if (result) {
    blocks.push({
      type: "tool_result",
      tool_use_id: toolCallId,
      output_preview: result,
      is_error: entry.status === "failed",
    })
  }
  return blocks
}

function thinkingBlock(text: string): ContentBlock | null {
  return hasMeaningfulThinking(text) ? { type: "thinking", text } : null
}

/**
 * OpenAB streams each reasoning token as its own transcript entry. Native
 * Codeg and ChatGPT keep one bundled thought on the assistant turn.
 */
export function transcriptToTurns(
  transcript: OpenABTranscriptSnapshot
): MessageTurn[] {
  const turns: MessageTurn[] = []
  let pending: { id: string; timestamp: string; text: string } | null = null

  const pushThinkingTurn = () => {
    if (!pending) return
    const block = thinkingBlock(pending.text)
    if (block) {
      turns.push({
        id: pending.id,
        role: "assistant",
        blocks: [block],
        timestamp: pending.timestamp,
      })
    }
    pending = null
  }

  for (const entry of latestTranscriptEntries(transcript)) {
    if (isAssistantThinking(entry)) {
      if (!pending) {
        pending = {
          id: entry.entry_id,
          timestamp: entry.timestamp ?? new Date(0).toISOString(),
          text: "",
        }
      }
      pending.text += entry.content
      continue
    }

    if (entry.role === "assistant") {
      const thinking = pending ? thinkingBlock(pending.text) : null
      pending = null
      turns.push({
        id: entry.entry_id,
        role: "assistant",
        blocks: [...(thinking ? [thinking] : []), ...entryBlocks(entry)],
        timestamp: entry.timestamp ?? new Date(0).toISOString(),
      })
      continue
    }

    pushThinkingTurn()
    turns.push({
      id: entry.entry_id,
      role: entry.role === "tool" ? "assistant" : entry.role,
      blocks: entryBlocks(entry),
      timestamp: entry.timestamp ?? new Date(0).toISOString(),
    })
  }

  pushThinkingTurn()
  return turns
}

function toToolCallState(entry: OpenABTranscriptEntry): ToolCallState {
  const tool = entry.tool_result ?? entry.tool_call
  const id = entry.tool_call_id ?? tool?.toolCallId ?? entry.entry_id
  const result = toolText(entry.tool_result ?? tool)
  return {
    id,
    kind: "other",
    label: tool?.title ?? entry.content ?? "Tool",
    status: normalizeToolStatus(entry.status),
    input: tool?.rawInput ?? null,
    output: result
      ? entry.status === "failed"
        ? { kind: "error", message: result }
        : { kind: "text", content: result }
      : null,
    content: entry.content || null,
    locations: null,
    meta: null,
  }
}

function latestLiveMessage(
  entries: OpenABTranscriptEntry[]
): LiveMessage | null {
  let end = -1
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (
      entry.role === "assistant" &&
      (entry.status === "streaming" || isAssistantThinking(entry))
    ) {
      end = i
      break
    }
  }
  if (end < 0) return null
  let start = end
  while (start > 0 && isAssistantThinking(entries[start - 1])) start -= 1
  const slice = entries.slice(start, end + 1)
  const thinkingText = slice
    .filter(isAssistantThinking)
    .map((entry) => entry.content)
    .join("")
  const textEntry = slice.find(
    (entry) => entry.role === "assistant" && entry.status !== "thinking"
  )
  const content: LiveMessage["content"] = []
  if (hasMeaningfulThinking(thinkingText)) {
    content.push({ kind: "thinking", text: thinkingText })
  }
  if (textEntry) content.push({ kind: "text", text: textEntry.content })
  if (content.length === 0) return null
  const last = slice[slice.length - 1]
  return {
    id: last.entry_id,
    role: "assistant",
    content,
    started_at: slice[0].timestamp ?? new Date().toISOString(),
  }
}

export function toLiveSessionSnapshot(
  session: OpenABSessionSnapshot,
  transcript: OpenABTranscriptSnapshot,
  conversationId: number,
  eventSeq?: number
): LiveSessionSnapshot {
  const entries = latestTranscriptEntries(transcript)
  const status = mapOpenABStatus(session.status)
  const tools = entries
    .filter((entry) => entry.role === "tool")
    .map(toToolCallState)
    .filter(
      (tool) => tool.status === "pending" || tool.status === "in_progress"
    )
  return {
    connection_id: session.session_id,
    conversation_id: conversationId,
    folder_id: OPENAB_FOLDER_ID,
    status,
    external_id: session.session_id,
    live_message: status === "prompting" ? latestLiveMessage(entries) : null,
    active_tool_calls: status === "prompting" ? tools : [],
    pending_permission: null,
    pending_question: null,
    pending_plan_approval: null,
    pending_user_message: null,
    active_delegations: [],
    feedback: [],
    background_outstanding: 0,
    feedback_tool_available: false,
    native_steering_available: false,
    modes: null,
    current_mode: null,
    config_options: null,
    prompt_capabilities: {
      image: false,
      audio: false,
      embedded_context: false,
    },
    usage: null,
    fork_supported: false,
    available_commands: [],
    selectors_ready: true,
    config_stale: false,
    config_stale_kind: null,
    last_error: mapOpenABLastError(session.last_error),
    session_failures: [],
    async_tasks: [],
    goal_actions: [],
    event_seq:
      eventSeq ??
      Math.max(
        0,
        (transcript.stream_next_sequence ?? transcript.next_sequence) - 1
      ),
  }
}

export function toConversationDetail(
  session: OpenABSessionSnapshot,
  transcript: OpenABTranscriptSnapshot,
  conversationId: number
): DbConversationDetail {
  const turns = transcriptToTurns(transcript)
  return {
    summary: toConversationSummary(session, conversationId, turns.length),
    turns,
    session_stats: null,
    transcript_watermark: transcript.next_sequence,
    turns_offset: 0,
    turns_total: turns.length,
    assistant_turns_before_offset: 0,
    prefix_hash: "0000000000000000",
    uncovered_prefix_max_ts: null,
  }
}
