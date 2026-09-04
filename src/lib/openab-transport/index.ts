import type {
  AcpAgentInfo,
  AcpAgentStatus,
  ConnectionInfo,
  ConversationConnectionInfo,
  ConversationSummary,
  FolderDetail,
  PromptInputBlock,
} from "@/lib/types"
import type {
  CallOptions,
  EventStream,
  Transport,
  UnsubscribeFn,
} from "@/lib/transport/types"
import {
  OPENAB_FOLDER_ID,
  mapOpenABStatus,
  toConversationDetail,
  toConversationSummary,
  toLiveSessionSnapshot,
  transcriptToTurns,
} from "./adapters"
import { OpenABEventStream, parseSseChunk } from "./event-stream"
import type {
  OpenABErrorBody,
  OpenABSseEvent,
  OpenABSessionSnapshot,
  OpenABTranscriptSnapshot,
  OpenABTransportConfig,
} from "./types"

const REQUEST_TIMEOUT_MS = 60_000
const RECONNECT_INITIAL_MS = 1_000
const RECONNECT_MAX_MS = 30_000

const EMPTY_LIST_COMMANDS = new Set([
  "automation_list",
  "work_task_list",
  "science_list",
  "science_list_all_install_statuses",
  "experts_list",
  "experts_list_all_install_statuses",
  "officecli_skill_list_all_install_statuses",
])

const EMPTY_OBJECT_COMMANDS = new Set([
  "app_update_status",
  "app_update_state",
  "check_app_update",
  "get_system_language_settings",
  "get_system_terminal_settings",
])

export class OpenABTransport implements Transport {
  private readonly config: OpenABTransportConfig
  private readonly stream: OpenABEventStream
  private readonly sseListeners = new Set<(event: OpenABSseEvent) => void>()
  private readonly reconnectListeners = new Set<() => void>()
  private sseController: AbortController | null = null
  private sseTask: Promise<void> | null = null
  private lastEventId: string | null = null
  private destroyed = false
  private pendingSessionId: string | null = null

  constructor(config: OpenABTransportConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
    }
    this.stream = new OpenABEventStream({
      loadSnapshot: (sessionId, eventSeq) =>
        this.loadLiveSnapshot(sessionId, eventSeq),
      subscribe: (listener) => this.subscribeSse(listener),
    })
  }

  async call<T>(
    command: string,
    args: Record<string, unknown> = {},
    options?: CallOptions
  ): Promise<T> {
    if (EMPTY_LIST_COMMANDS.has(command)) return [] as T
    if (EMPTY_OBJECT_COMMANDS.has(command)) return {} as T

    switch (command) {
      case "health":
        return { status: "ok" } as T
      case "get_feedback_settings":
        return { enabled: false } as T
      case "list_folder_groups":
      case "load_folder_history":
      case "list_child_conversations":
        return [] as T
      case "list_all_folder_details":
      case "list_open_folder_details":
        return [this.virtualFolder()] as T
      case "list_opened_tabs":
        return this.readOpenedTabs() as T
      case "save_opened_tabs":
        return this.saveOpenedTabs(args) as T
      case "create_chat_dir":
        return { path: this.virtualFolder().path } as T
      case "acp_list_agent_skills":
        return {
          supported: false,
          message: null,
          locations: [],
          skills: [],
        } as T
      case "acp_list_agents":
        return [this.agentInfo()] as T
      case "acp_get_agent_status":
        return this.agentStatus(
          String(args.agentType ?? this.config.profileId)
        ) as T
      case "list_all_conversations": {
        const sessions = await this.listSessions(options)
        return sessions.map((session) => toConversationSummary(session)) as T
      }
      case "list_conversations": {
        const sessions = await this.listSessions(options)
        return sessions.map((session) => this.classicSummary(session)) as T
      }
      case "get_folder_conversation": {
        const sessionId = String(args.conversationId)
        const [session, transcript] = await Promise.all([
          this.getSession(sessionId, options),
          this.getTranscript(sessionId, options),
        ])
        return toConversationDetail(session, transcript) as T
      }
      case "get_conversation": {
        const sessionId = String(args.conversationId)
        const [session, transcript] = await Promise.all([
          this.getSession(sessionId, options),
          this.getTranscript(sessionId, options),
        ])
        return {
          summary: this.classicSummary(session),
          turns: transcriptToTurns(transcript),
        } as T
      }
      case "acp_connect": {
        if (typeof args.sessionId === "string" && args.sessionId) {
          await this.getSession(args.sessionId, options)
          return args.sessionId as T
        }
        const session = await this.createSession(options)
        this.pendingSessionId = session.session_id
        return session.session_id as T
      }
      case "create_conversation":
        return this.claimOrCreateSession(options) as Promise<T>
      case "create_chat_conversation": {
        const sessionId = await this.claimOrCreateSession(options)
        return {
          conversationId: sessionId as unknown as number,
          folderId: OPENAB_FOLDER_ID,
          folder: this.virtualFolder(),
        } as T
      }
      case "acp_prompt": {
        const text = this.promptText(args.blocks)
        await this.request(
          `/api/v1/sessions/${encodeURIComponent(String(args.connectionId))}/messages`,
          {
            method: "POST",
            body: JSON.stringify({ text }),
          },
          options
        )
        return undefined as T
      }
      case "acp_cancel":
        await this.request(
          `/api/v1/sessions/${encodeURIComponent(String(args.connectionId))}/cancel`,
          { method: "POST" },
          options,
          false
        )
        return undefined as T
      case "acp_get_session_snapshot":
        return this.loadLiveSnapshot(String(args.connectionId)) as Promise<T>
      case "acp_get_session_snapshot_by_conversation":
        return this.loadLiveSnapshot(String(args.conversationId)) as Promise<T>
      case "acp_find_connection_for_conversation": {
        const sessionId =
          typeof args.sessionId === "string"
            ? args.sessionId
            : String(args.conversationId)
        await this.getSession(sessionId, options)
        const result: ConversationConnectionInfo = {
          connection_id: sessionId,
          event_seq: 0,
        }
        return result as T
      }
      case "acp_list_connections": {
        const sessions = await this.listSessions(options)
        const connections: ConnectionInfo[] = sessions.map((session) => ({
          id: session.session_id,
          agent_type: session.agent,
          status: mapOpenABStatus(session.status),
        }))
        return connections as T
      }
      case "acp_touch_connection":
        return true as T
      case "acp_disconnect":
        return undefined as T
      default:
        return this.localUnsupported(command) as T
    }
  }

  async subscribe<T>(
    _event: string,
    _handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    return () => {}
  }

  isDesktop(): boolean {
    return false
  }

  onReconnect(callback: () => void): UnsubscribeFn {
    this.reconnectListeners.add(callback)
    return () => this.reconnectListeners.delete(callback)
  }

  waitForReady(): Promise<void> {
    return Promise.resolve()
  }

  eventStream(): EventStream {
    return this.stream
  }

  destroy(): void {
    this.destroyed = true
    this.sseController?.abort()
    this.sseController = null
    this.sseListeners.clear()
    this.reconnectListeners.clear()
    this.stream.destroy()
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options?: CallOptions,
    parseJson = true
  ): Promise<T> {
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? REQUEST_TIMEOUT_MS
    )
    let response: Response
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${this.config.token}`,
          ...init.headers,
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }
    if (response.status === 401) this.config.onUnauthorized?.()
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as OpenABErrorBody
      throw {
        code: response.status === 409 ? "turn_in_progress" : body.code,
        message: body.error ?? `HTTP ${response.status}`,
        status: response.status,
      }
    }
    if (!parseJson || response.status === 204) return undefined as T
    return response.json() as Promise<T>
  }

  private listSessions(
    options?: CallOptions
  ): Promise<OpenABSessionSnapshot[]> {
    return this.request("/api/v1/sessions", {}, options)
  }

  private getSession(
    sessionId: string,
    options?: CallOptions
  ): Promise<OpenABSessionSnapshot> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      {},
      options
    )
  }

  private getTranscript(
    sessionId: string,
    options?: CallOptions
  ): Promise<OpenABTranscriptSnapshot> {
    return this.request(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`,
      {},
      options
    )
  }

  private createSession(options?: CallOptions): Promise<OpenABSessionSnapshot> {
    return this.request(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({ profile_id: this.config.profileId }),
      },
      options
    )
  }

  private async claimOrCreateSession(options?: CallOptions): Promise<string> {
    if (this.pendingSessionId) {
      const sessionId = this.pendingSessionId
      this.pendingSessionId = null
      return sessionId
    }
    return (await this.createSession(options)).session_id
  }

  private async loadLiveSnapshot(sessionId: string, eventSeq?: number) {
    const [session, transcript] = await Promise.all([
      this.getSession(sessionId),
      this.getTranscript(sessionId),
    ])
    return toLiveSessionSnapshot(session, transcript, eventSeq)
  }

  private promptText(blocks: unknown): string {
    if (!Array.isArray(blocks)) throw new Error("text is required")
    const text = (blocks as PromptInputBlock[])
      .filter(
        (block): block is Extract<PromptInputBlock, { type: "text" }> =>
          block.type === "text"
      )
      .map((block) => block.text)
      .join("\n")
      .trim()
    if (!text) throw new Error("text is required")
    return text
  }

  private virtualFolder(): FolderDetail {
    return {
      id: OPENAB_FOLDER_ID,
      name: "OpenAB",
      path: "/workspace",
      git_branch: null,
      default_agent_type: this.config.profileId,
      last_opened_at: new Date().toISOString(),
      sort_order: 0,
      color: "inherit",
      parent_id: null,
      kind: "chat",
      alias: null,
      group_id: null,
    }
  }

  private classicSummary(session: OpenABSessionSnapshot): ConversationSummary {
    return {
      id: session.session_id,
      agent_type: session.agent,
      folder_path: session.workdir,
      folder_name: session.workdir.split("/").filter(Boolean).pop() ?? "OpenAB",
      title: session.title ?? session.profile_name,
      started_at: session.created_at,
      ended_at: session.status === "idle" ? session.updated_at : null,
      message_count: 0,
      model: session.model,
      git_branch: null,
    }
  }

  private agentStatus(agentType: string): AcpAgentStatus {
    return {
      agent_type: agentType,
      available: true,
      enabled: true,
      installed_version: null,
      is_acp_adapter: false,
    }
  }

  private agentInfo(): AcpAgentInfo {
    return {
      agent_type: this.config.profileId,
      skills_capable: false,
      registry_id: this.config.profileId,
      registry_version: null,
      supports_custom_version: false,
      name: this.config.profileId,
      description: "OpenAB managed profile",
      available: true,
      distribution_type: "openab",
      is_acp_adapter: false,
    } as AcpAgentInfo
  }

  private readOpenedTabs(): unknown {
    try {
      return JSON.parse(
        localStorage.getItem("openab_opened_tabs") ?? '{"version":0,"items":[]}'
      )
    } catch {
      return { version: 0, items: [] }
    }
  }

  private saveOpenedTabs(args: Record<string, unknown>): unknown {
    const snapshot = {
      version: Number(args.expectedVersion ?? 0) + 1,
      items: Array.isArray(args.items) ? args.items : [],
    }
    localStorage.setItem("openab_opened_tabs", JSON.stringify(snapshot))
    return snapshot
  }

  private localUnsupported(command: string): unknown {
    if (
      command.startsWith("list_") ||
      command.endsWith("_list") ||
      command.includes("_list_")
    ) {
      return []
    }
    if (
      command.startsWith("update_") ||
      command.startsWith("save_") ||
      command.startsWith("remove_")
    ) {
      return undefined
    }
    return null
  }

  private subscribeSse(
    listener: (event: OpenABSseEvent) => void
  ): UnsubscribeFn {
    this.sseListeners.add(listener)
    this.ensureSse()
    return () => {
      this.sseListeners.delete(listener)
      if (this.sseListeners.size === 0) {
        this.sseController?.abort()
        this.sseController = null
      }
    }
  }

  private ensureSse(): void {
    if (this.sseTask || this.destroyed) return
    this.sseTask = this.runSse().finally(() => {
      this.sseTask = null
    })
  }

  private async runSse(): Promise<void> {
    let backoff = RECONNECT_INITIAL_MS
    while (!this.destroyed && this.sseListeners.size > 0) {
      this.sseController = new AbortController()
      try {
        const response = await fetch(
          `${this.config.baseUrl}/api/v1/sessions/events`,
          {
            headers: {
              Accept: "text/event-stream",
              Authorization: `Bearer ${this.config.token}`,
              ...(this.lastEventId
                ? { "Last-Event-ID": this.lastEventId }
                : {}),
            },
            signal: this.sseController.signal,
          }
        )
        if (response.status === 401) {
          this.config.onUnauthorized?.()
          return
        }
        if (!response.ok || !response.body) {
          throw new Error(`SSE HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        backoff = RECONNECT_INITIAL_MS
        while (!this.destroyed) {
          const { done, value } = await reader.read()
          if (done) break
          const parsed = parseSseChunk(
            buffer,
            decoder.decode(value, { stream: true })
          )
          buffer = parsed.rest
          for (const event of parsed.events) {
            if (event.id) this.lastEventId = event.id
            for (const subscriber of this.sseListeners) subscriber(event)
          }
        }
      } catch (error) {
        if (
          this.destroyed ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return
        }
      }
      if (this.destroyed || this.sseListeners.size === 0) return
      for (const listener of this.reconnectListeners) listener()
      await new Promise((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }
}
