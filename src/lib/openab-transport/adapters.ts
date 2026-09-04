import type {
  ContentBlock,
  DbConversationDetail,
  DbConversationSummary,
  LiveMessage,
  LiveSessionSnapshot,
  MessageTurn,
  ToolCallState,
} from "@/lib/types"
import type {
  OpenABSessionSnapshot,
  OpenABToolCall,
  OpenABTranscriptEntry,
  OpenABTranscriptSnapshot,
} from "./types"

export const OPENAB_FOLDER_ID = 0

function opaqueConversationId(sessionId: string): number {
  return sessionId as unknown as number
}

export function mapOpenABStatus(status: string): LiveSessionSnapshot["status"] {
  if (status === "running" || status === "prompting") return "prompting"
  if (status === "error") return "error"
  return "connected"
}

export function toConversationSummary(
  session: OpenABSessionSnapshot,
  messageCount = 0
): DbConversationSummary {
  return {
    id: opaqueConversationId(session.session_id),
    folder_id: OPENAB_FOLDER_ID,
    title: session.title ?? session.profile_name ?? session.session_id,
    title_locked: false,
    agent_type: session.agent,
    status: session.status === "error" ? "cancelled" : "in_progress",
    kind: "chat",
    model: session.model,
    git_branch: null,
    external_id: session.session_id,
    message_count: messageCount,
    child_count: 0,
    created_at: session.created_at,
    updated_at: session.updated_at,
    pinned_at: null,
  }
}

export function latestTranscriptEntries(
  transcript: OpenABTranscriptSnapshot
): OpenABTranscriptEntry[] {
  const entries = new Map<string, OpenABTranscriptEntry>()
  for (const entry of transcript.entries) {
    const current = entries.get(entry.entry_id)
    if (!current || entry.sequence >= current.sequence) {
      entries.set(entry.entry_id, entry)
    }
  }
  return [...entries.values()].sort((a, b) => a.sequence - b.sequence)
}

function toolText(tool: OpenABToolCall | undefined): string | null {
  if (!tool?.content) return null
  const text = tool.content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
  return text || null
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
      input_preview: tool?.rawInput ? JSON.stringify(tool.rawInput) : null,
      status: entry.status,
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

export function transcriptToTurns(
  transcript: OpenABTranscriptSnapshot
): MessageTurn[] {
  return latestTranscriptEntries(transcript).map((entry) => ({
    id: entry.entry_id,
    role: entry.role === "tool" ? "assistant" : entry.role,
    blocks: entryBlocks(entry),
    timestamp: entry.timestamp ?? new Date(0).toISOString(),
  }))
}

function toToolCallState(entry: OpenABTranscriptEntry): ToolCallState {
  const tool = entry.tool_result ?? entry.tool_call
  const id = entry.tool_call_id ?? tool?.toolCallId ?? entry.entry_id
  const result = toolText(entry.tool_result ?? tool)
  return {
    id,
    kind: "other",
    label: tool?.title ?? entry.content ?? "Tool",
    status:
      entry.status === "running"
        ? "in_progress"
        : entry.status === "failed"
          ? "failed"
          : "completed",
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
  const entry = [...entries]
    .reverse()
    .find(
      (candidate) =>
        candidate.role === "assistant" &&
        (candidate.status === "streaming" || candidate.status === "thinking")
    )
  if (!entry) return null
  return {
    id: entry.entry_id,
    role: "assistant",
    content: [
      entry.status === "thinking"
        ? { kind: "thinking", text: entry.content }
        : { kind: "text", text: entry.content },
    ],
    started_at: entry.timestamp ?? new Date().toISOString(),
  }
}

export function toLiveSessionSnapshot(
  session: OpenABSessionSnapshot,
  transcript: OpenABTranscriptSnapshot,
  eventSeq?: number
): LiveSessionSnapshot {
  const entries = latestTranscriptEntries(transcript)
  const tools = entries.filter((entry) => entry.role === "tool")
  return {
    connection_id: session.session_id,
    conversation_id: opaqueConversationId(session.session_id),
    folder_id: OPENAB_FOLDER_ID,
    status: mapOpenABStatus(session.status),
    external_id: session.session_id,
    live_message: latestLiveMessage(entries),
    active_tool_calls: tools.map(toToolCallState),
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
    event_seq:
      eventSeq ?? Math.max(0, transcript.stream_next_sequence - 1),
  }
}

export function toConversationDetail(
  session: OpenABSessionSnapshot,
  transcript: OpenABTranscriptSnapshot
): DbConversationDetail {
  const turns = transcriptToTurns(transcript)
  return {
    summary: toConversationSummary(session, turns.length),
    turns,
    transcript_watermark: transcript.next_sequence - 1,
  }
}
