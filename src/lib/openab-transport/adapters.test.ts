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

  it("keeps idle OpenAB sessions visible as resumable conversations", () => {
    const summary = toConversationSummary({ ...session, status: "idle" }, 42)

    expect(summary.status).toBe("pending_review")
    expect(summary.kind).toBe("chat")
  })

  it("keeps connected OpenAB sessions visible as resumable conversations", () => {
    const summary = toConversationSummary(
      { ...session, status: "connected" },
      42
    )

    expect(summary.status).toBe("pending_review")
    expect(summary.kind).toBe("chat")
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

describe("OpenAB activity boundaries", () => {
  it.each([
    "idle",
    "connected",
    "completed",
    "cancelled",
    "error",
    "failed",
    "disconnected",
  ])("clears stale live transcript state for %s", (status) => {
    const live = toLiveSessionSnapshot({ ...session, status }, transcript(), 42)
    expect(live.status).not.toBe("prompting")
    expect(live.live_message).toBeNull()
    expect(live.active_tool_calls).toEqual([])
    expect(toConversationSummary({ ...session, status }, 42).status).not.toBe(
      "in_progress"
    )
  })
  it.each(["running", "busy", "prompting"])(
    "shows activity only for %s",
    (status) => {
      expect(toConversationSummary({ ...session, status }, 42).status).toBe(
        "in_progress"
      )
    }
  )
  it.each(["", " : ", "...", "\uFF1A"])(
    "omits placeholder reasoning %j",
    (content) => {
      const data = {
        ...transcript(),
        entries: [
          {
            entry_id: "thought",
            sequence: 1,
            role: "assistant" as const,
            status: "thinking",
            content,
          },
        ],
      }
      expect(transcriptToTurns(data)).toEqual([])
      expect(toLiveSessionSnapshot(session, data, 42).live_message).toBeNull()
    }
  )
  it("preserves meaningful reasoning", () => {
    const data = {
      ...transcript(),
      entries: [
        {
          entry_id: "thought",
          sequence: 1,
          role: "assistant" as const,
          status: "thinking",
          content: "Check the session lifecycle",
        },
      ],
    }
    expect(transcriptToTurns(data)[0].blocks).toEqual([
      { type: "thinking", text: "Check the session lifecycle" },
    ])
  })
  it("bundles per-token thinking into one thought on the assistant turn", () => {
    const data = {
      ...transcript(),
      entries: [
        {
          entry_id: "user-1",
          sequence: 1,
          role: "user" as const,
          status: "completed",
          content: "ping",
        },
        {
          entry_id: "t1",
          sequence: 2,
          role: "assistant" as const,
          status: "thinking",
          content: "The",
        },
        {
          entry_id: "t2",
          sequence: 3,
          role: "assistant" as const,
          status: "thinking",
          content: " user",
        },
        {
          entry_id: "t3",
          sequence: 4,
          role: "assistant" as const,
          status: "thinking",
          content: " pinged",
        },
        {
          entry_id: "a1",
          sequence: 5,
          role: "assistant" as const,
          status: "completed",
          content: "pong",
        },
      ],
    }
    const turns = transcriptToTurns(data)
    expect(turns).toHaveLength(2)
    expect(turns[0].role).toBe("user")
    expect(turns[1].blocks).toEqual([
      { type: "thinking", text: "The user pinged" },
      { type: "text", text: "pong" },
    ])
  })
  it("appends live thinking tokens onto one in-flight thought", () => {
    const live = toLiveSessionSnapshot(
      session,
      {
        ...transcript(),
        entries: [
          {
            entry_id: "t1",
            sequence: 1,
            role: "assistant",
            status: "thinking",
            content: "The",
          },
        ],
      },
      42
    )
    const next = applyOpenABSseToSnapshot(
      live,
      {
        id: "g:2",
        event: "transcript",
        data: {
          session_id: session.session_id,
          sequence: 2,
          entry: {
            entry_id: "t2",
            sequence: 2,
            role: "assistant",
            status: "thinking",
            content: " user",
          },
        },
      },
      2
    )
    expect(next?.live_message?.content).toEqual([
      { kind: "thinking", text: "The user" },
    ])
  })
})
