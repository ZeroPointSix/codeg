import type {
  HubEvent,
  HubSessionSnapshot,
  HubTranscriptSnapshot,
} from "./hub-contract"

const snapshot: HubSessionSnapshot = {
  session_id: "admin:fixture-session",
  agent: "fixture-acp",
  source: {
    platform: "admin",
    thread_id: "fixture-session",
  },
  workdir: "/workspace/project",
  profile_id: "codex-default",
  profile_name: "Codex Default",
  profile_status: "active",
  model: "gpt-5",
  reasoning_effort: "high",
  metadata_source: "acp",
  status: "idle",
  created_at: "2026-09-03T00:00:00Z",
  updated_at: "2026-09-03T00:00:00Z",
}

const transcript: HubTranscriptSnapshot = {
  session_id: snapshot.session_id,
  entries: [
    {
      entry_id: "entry-1",
      sequence: 1,
      timestamp: "2026-09-03T00:00:01Z",
      role: "user",
      content: "请检查当前变更并运行测试",
      status: "completed",
    },
    {
      entry_id: "entry-2",
      sequence: 2,
      timestamp: "2026-09-03T00:00:02Z",
      role: "assistant",
      content: "检查完成，测试通过。",
      status: "completed",
    },
  ],
  overflowed: false,
  oldest_sequence: 1,
  next_sequence: 3,
  stream_generation: "fixture-generation",
  stream_next_sequence: 4,
}

export interface HubContractFixture {
  contract: "codeg-openab-session"
  version: 1
  session_id: string
  encoded_session_id: string
  auth: {
    header: "Authorization"
    scheme: "Bearer"
    token_placeholder: "<admin-token>"
    query_token: false
  }
  snapshot: HubSessionSnapshot
  transcript: HubTranscriptSnapshot
  endpoints: {
    list_sessions: { method: "GET"; path: string }
    create_session: { method: "POST"; path: string }
    get_session: { method: "GET"; path: string; example_path: string }
    get_transcript: { method: "GET"; path: string; example_path: string }
    stream_session_events: { method: "GET"; path: string }
    send_message: { method: "POST"; path: string; example_path: string }
    cancel_session: { method: "POST"; path: string; example_path: string }
  }
  events: HubEvent[]
  recovery_events: HubEvent[]
}

export const CODEG_HUB_CONTRACT_FIXTURE: HubContractFixture = {
  contract: "codeg-openab-session",
  version: 1,
  session_id: snapshot.session_id,
  encoded_session_id: "admin%3Afixture-session",
  auth: {
    header: "Authorization",
    scheme: "Bearer",
    token_placeholder: "<admin-token>",
    query_token: false,
  },
  snapshot,
  transcript,
  endpoints: {
    list_sessions: {
      method: "GET",
      path: "/api/v1/sessions",
    },
    create_session: {
      method: "POST",
      path: "/api/v1/sessions",
    },
    get_session: {
      method: "GET",
      path: "/api/v1/sessions/{session_id}",
      example_path: "/api/v1/sessions/admin%3Afixture-session",
    },
    get_transcript: {
      method: "GET",
      path: "/api/v1/sessions/{session_id}/transcript",
      example_path: "/api/v1/sessions/admin%3Afixture-session/transcript",
    },
    stream_session_events: {
      method: "GET",
      path: "/api/v1/sessions/events",
    },
    send_message: {
      method: "POST",
      path: "/api/v1/sessions/{session_id}/messages",
      example_path: "/api/v1/sessions/admin%3Afixture-session/messages",
    },
    cancel_session: {
      method: "POST",
      path: "/api/v1/sessions/{session_id}/cancel",
      example_path: "/api/v1/sessions/admin%3Afixture-session/cancel",
    },
  },
  events: [
    {
      id: "fixture-generation:3",
      event: "transcript",
      data: {
        sequence: 3,
        session_id: snapshot.session_id,
        entry: transcript.entries[0],
      },
    },
    {
      id: "fixture-generation:4",
      event: "status_changed",
      data: {
        sequence: 4,
        event: "status_changed",
        snapshot,
      },
    },
  ],
  recovery_events: [
    {
      id: "fixture-generation:0",
      event: "cursor_reset",
      data: {
        error: "event cursor generation changed",
        action: "refetch /api/v1/sessions before continuing the stream",
      },
    },
    {
      id: null,
      event: "error",
      data: {
        error: "event history unavailable",
        action: "refetch /api/v1/sessions before continuing the stream",
      },
    },
    {
      id: null,
      event: "error",
      data: {
        error: "event stream lagged",
      },
    },
  ],
}
