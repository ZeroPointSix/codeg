import {
  applyOpenABSseToSnapshot,
  latestTranscriptEntries,
  toConversationSummary,
  toLiveSessionSnapshot,
  transcriptToTurns,
} from "./adapters"
import { denormalizeSnapshot } from "@/lib/snapshot-denormalize"
import type { OpenABSessionSnapshot, OpenABTranscriptSnapshot } from "./types"

const session: OpenABSessionSnapshot = {
  session_id: "slack:team/thread:001",
  agent: "codex",
  source: { platform: "slack", thread_id: "thread:001" },
  workdir: "/workspace",
  profile_id: "codex-default",
  profile_name: "Codex",
  profile_status: "ready",
  model: "gpt-5",
  reasoning_effort: "medium",
  metadata_source: "runtime",
  status: "running",
  created_at: "2026-09-04T00:00:00Z",
  updated_at: "2026-09-04T00:01:00Z",
}

function transcript(): OpenABTranscriptSnapshot {
  return {
    session_id: session.session_id,
    entries: [
      {
        entry_id: "assistant-1",
        sequence: 1,
        role: "assistant",
        content: "old",
        status: "streaming",
      },
      {
        entry_id: "assistant-1",
        sequence: 2,
        role: "assistant",
        content: "new",
        status: "streaming",
      },
      {
        entry_id: "tool-1",
        sequence: 3,
        role: "tool",
        content: "Run checks",
        status: "completed",
        tool_call_id: "call-1",
        tool_result: {
          title: "Terminal",
          content: [{ type: "text", text: "ok" }],
        },
      },
      {
        entry_id: "assistant-1",
        sequence: 4,
        role: "assistant",
        content: "new",
        status: "streaming",
      },
    ],
    overflowed: false,
    oldest_sequence: 1,
    next_sequence: 5,
    stream_generation: "generation-a",
    stream_next_sequence: 12,
  }
}

describe("OpenAB adapters", () => {
  it("keeps opaque session IDs external to the numeric UI identity", () => {
    const summary = toConversationSummary(session, 42)

    expect(summary.id).toBe(42)
    expect(summary.external_id).toBe(session.session_id)
  })

  it("keeps only the latest revision of each transcript entry", () => {
    expect(latestTranscriptEntries(transcript())).toMatchObject([
      { entry_id: "assistant-1", sequence: 4, content: "new" },
      { entry_id: "tool-1", sequence: 3 },
    ])
  })

  it("maps streaming output and tool results into existing workbench shapes", () => {
    const turns = transcriptToTurns(transcript())
    const live = toLiveSessionSnapshot(session, transcript(), 42)

    expect(turns).toHaveLength(2)
    expect(turns[1].blocks).toMatchObject([
      {
        type: "tool_use",
        tool_use_id: "call-1",
        tool_name: "Terminal",
      },
      {
        type: "tool_result",
        tool_use_id: "call-1",
        output_preview: "ok",
        is_error: false,
      },
    ])
    expect(live.connection_id).toBe(session.session_id)
    expect(live.conversation_id).toBe(42)
    expect(live.live_message?.content).toEqual([{ kind: "text", text: "new" }])
    expect(live.event_seq).toBe(11)
  })

  it("maps last_error from the OpenAB session snapshot", () => {
    const live = toLiveSessionSnapshot(
      {
        ...session,
        status: "error",
        last_error: {
          message: "quota exceeded",
          code: "resource_exhausted",
          details: "retry after 60s",
        },
      },
      transcript(),
      42
    )
    expect(live.external_id).toBe(session.session_id)
    expect(live.connection_id).toBe(session.session_id)
    expect(live.last_error).toEqual({
      message: "quota exceeded",
      code: "resource_exhausted",
      details: "retry after 60s",
    })
  })

  it("upserts a transcript SSE entry onto the live snapshot without REST", () => {
    const live = toLiveSessionSnapshot(session, transcript(), 42)
    const next = applyOpenABSseToSnapshot(
      live,
      {
        id: "generation-a:20",
        event: "transcript",
        data: {
          session_id: session.session_id,
          sequence: 20,
          entry: {
            entry_id: "assistant-1",
            sequence: 20,
            role: "assistant",
            content: "newer",
            status: "streaming",
          },
        },
      },
      20
    )
    expect(next?.live_message?.content).toEqual([
      { kind: "text", text: "newer" },
    ])
    expect(next?.event_seq).toBe(20)
  })

  it("feeds OpenAB last_error into the workbench snapshot patch", () => {
    const live = toLiveSessionSnapshot(
      {
        ...session,
        status: "error",
        last_error: {
          message: "quota exceeded",
          code: "resource_exhausted",
          details: "retry after 60s",
        },
      },
      transcript(),
      42
    )
    const patch = denormalizeSnapshot(live)
    expect(patch.lastError).toBe("quota exceeded")
    expect(patch.lastErrorDetails).toBe("retry after 60s")
  })
})
