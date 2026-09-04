export interface OpenABSessionSource {
  platform: string
  thread_id: string
}

export interface OpenABSessionSnapshot {
  session_id: string
  agent: string
  source: OpenABSessionSource
  workdir: string
  profile_id: string
  profile_name: string
  profile_status: string
  model: string | null
  reasoning_effort: string | null
  metadata_source: string
  status: string
  created_at: string
  updated_at: string
  title?: string | null
}

export interface OpenABToolCall {
  sessionUpdate?: string
  toolCallId?: string
  title?: string
  rawInput?: unknown
  content?: Array<{ type?: string; text?: string }>
  [key: string]: unknown
}

export interface OpenABTranscriptEntry {
  entry_id: string
  sequence: number
  timestamp?: string
  role: "user" | "assistant" | "system" | "tool"
  content: string
  status: string
  tool_call?: OpenABToolCall
  tool_result?: OpenABToolCall
  tool_call_id?: string
}

export interface OpenABTranscriptSnapshot {
  session_id: string
  entries: OpenABTranscriptEntry[]
  overflowed: boolean
  oldest_sequence: number
  next_sequence: number
  stream_generation: string
  stream_next_sequence: number
}

export interface OpenABSseEvent {
  id: string | null
  event: string
  data: unknown
}

export interface OpenABTransportConfig {
  baseUrl: string
  token: string
  profileId: string
  onUnauthorized?: () => void
  fetchImpl?: typeof fetch
  storage?: Storage | null
}

export interface OpenABErrorBody {
  error?: string
  code?: string
}
