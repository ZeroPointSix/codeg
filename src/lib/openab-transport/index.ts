import type {
  AcpAgentInfo,
  AcpAgentStatus,
  AgentStats,
  ConnectionInfo,
  ConversationConnectionInfo,
  ConversationSummary,
  DbConversationSummary,
  FolderDetail,
  GitHeadInfo,
  OpenedTab,
  OpenedTabsSnapshot,
  PromptInputBlock,
  SaveTabsOutcome,
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
import {
  openABIdentityStorageKey,
  openABOpenedTabsStorageKey,
} from "./storage-keys"
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
const OPENAB_AGENT_TYPE = "openab"
const OPENAB_AGENT_VERSION = "0.9.15"

const EMPTY_LIST_COMMANDS = new Set([
  "automation_list",
  "work_task_list",
  "science_list",
  "science_list_all_install_statuses",
  "experts_list",
  "experts_list_all_install_statuses",
  "officecli_skill_list_all_install_statuses",
])

interface PersistedIdentityState {
  nextId: number
  entries: Array<{ sessionId: string; conversationId: number }>
}

export class OpenABTransport implements Transport {
  private readonly config: OpenABTransportConfig
  private readonly fetchImpl: typeof fetch
  private readonly storage: Storage | null
  private readonly stream: OpenABEventStream
  private readonly sseListeners = new Set<(event: OpenABSseEvent) => void>()
  private readonly reconnectListeners = new Set<() => void>()
  private readonly sessionToConversationId = new Map<string, number>()
  private readonly conversationIdToSession = new Map<number, string>()
  private readonly identityKey: string
  private readonly openedTabsKey: string
  private sseController: AbortController | null = null
  private sseTask: Promise<void> | null = null
  private lastEventId: string | null = null
  private destroyed = false
  private readonly lifetime = new AbortController()
  private pendingSessionIds: string[] = []
  private nextConversationId = 1

  constructor(config: OpenABTransportConfig) {
    this.config = {
      ...config,
      baseUrl: config.baseUrl.replace(/\/+$/, ""),
      profileId: config.profileId.trim(),
    }
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.storage =
      config.storage === undefined
        ? typeof localStorage === "undefined"
          ? null
          : localStorage
        : config.storage
    this.identityKey = openABIdentityStorageKey(
      this.config.baseUrl,
      this.config.profileId
    )
    this.openedTabsKey = openABOpenedTabsStorageKey(
      this.config.baseUrl,
      this.config.profileId
    )
    this.restoreIdentities()
    this.stream = new OpenABEventStream({
      loadSnapshot: (sessionId, eventSeq) =>
        this.loadLiveSnapshot(sessionId, eventSeq),
      recover: async () => {
        try {
          await this.listSessions()
        } finally {
          this.notifyReconnect()
        }
      },
      subscribe: (listener) => this.subscribeSse(listener),
    })
  }

  async call<T>(
    command: string,
    args: Record<string, unknown> = {},
    options?: CallOptions
  ): Promise<T> {
    if (EMPTY_LIST_COMMANDS.has(command)) return [] as T

    switch (command) {
      case "health":
        return { status: "ok", version: "0.30.4" } as T
      case "app_update_state":
        return { seq: 0, status: "idle" } as T
      case "app_update_status":
        return {
          currentVersion: "0.30.4",
          selfUpdateSupported: false,
          capability: "reexec",
          runtime: "openab",
          restartDelayMs: 0,
          rollbackAvailable: false,
          liveProgress: false,
        } as T
      case "check_app_update":
        return {
          currentVersion: "0.30.4",
          update: null,
          selfUpdateSupported: false,
          liveProgress: false,
        } as T
      case "get_feedback_settings":
        return { enabled: false } as T
      case "get_system_language_settings":
        return { mode: "system", language: "en" } as T
      case "get_system_terminal_settings":
        return { default_shell: null } as T
      case "get_available_terminal_shells":
        return { options: [], resolved_shell: "" } as T
      case "get_system_proxy_settings":
        return { enabled: false, proxy_url: null } as T
      case "get_system_rendering_settings":
        return { disable_hardware_acceleration: false } as T
      case "get_system_autostart_settings":
        return { enabled: false } as T
      case "list_folder_groups":
      case "load_folder_history":
      case "list_child_conversations":
      case "list_open_folder_details":
      case "list_folder_commands":
      case "bootstrap_folder_commands_from_package_json":
        return [] as T
      case "list_all_folder_details":
        return [this.virtualFolder()] as T
      case "get_folder":
      case "open_folder_by_id":
        return this.virtualFolder() as T
      case "get_git_branch":
        return null as T
      case "get_git_head":
        return {
          is_repo: false,
          branch: null,
          detached: false,
          short_sha: null,
        } satisfies GitHeadInfo as T
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
        return this.agentStatus() as T
      case "list_all_conversations": {
        const sessions = await this.listSessions(options)
        return sessions.map((session) => this.conversationSummary(session)) as T
      }
      case "list_conversations": {
        const sessions = await this.listSessions(options)
        return sessions.map((session) => this.classicSummary(session)) as T
      }
      case "get_folder_conversation": {
        const sessionId = this.sessionIdForConversation(args.conversationId)
        const [session, transcript] = await Promise.all([
          this.getSession(sessionId, options),
          this.getTranscript(sessionId, options),
        ])
        return toConversationDetail(
          session,
          transcript,
          this.conversationIdForSession(sessionId)
        ) as T
      }
      case "get_folder_conversation_turns": {
        const sessionId = this.sessionIdForConversation(args.conversationId)
        const transcript = await this.getTranscript(sessionId, options)
        const turns = transcriptToTurns(transcript)
        const requestedBefore = Number(args.beforeIndex)
        const beforeIndex = Math.min(
          Number.isFinite(requestedBefore) ? requestedBefore : turns.length,
          turns.length
        )
        const limit = Math.max(1, Number(args.limit) || 50)
        const start = Math.max(0, beforeIndex - limit)
        return {
          turns: turns.slice(start, beforeIndex),
          turns_offset: start,
          turns_total: turns.length,
          assistant_turns_before_offset: turns
            .slice(0, start)
            .filter((turn) => turn.role === "assistant").length,
          prefix_hash: "0000000000000000",
          prefix_hash_before_index: "0000000000000000",
          uncovered_prefix_max_ts:
            start > 0 ? (turns[start - 1]?.timestamp ?? null) : null,
        } as T
      }
      case "get_conversation": {
        const sessionId = this.sessionIdForConversation(args.conversationId)
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
        this.pendingSessionIds.push(session.session_id)
        return session.session_id as T
      }
      case "create_conversation": {
        const sessionId = await this.claimOrCreateSession(options)
        return this.conversationIdForSession(sessionId) as T
      }
      case "create_chat_conversation": {
        const sessionId = await this.claimOrCreateSession(options)
        return {
          conversationId: this.conversationIdForSession(sessionId),
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
          options,
          false
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
        return this.loadLiveSnapshot(
          this.sessionIdForConversation(args.conversationId)
        ) as Promise<T>
      case "acp_find_connection_for_conversation": {
        const sessionId =
          typeof args.sessionId === "string"
            ? args.sessionId
            : this.sessionIdForConversation(args.conversationId)
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
          agent_type: OPENAB_AGENT_TYPE,
          status: mapOpenABStatus(session.status),
        }))
        return connections as T
      }
      case "acp_touch_connection":
        return true as T
      case "acp_disconnect":
        return undefined as T
      case "get_stats": {
        const sessions = await this.listSessions(options)
        return this.statsFor(
          sessions.map((session) => this.conversationSummary(session))
        ) as T
      }
      case "get_sidebar_data": {
        const sessions = await this.listSessions(options)
        const conversations = sessions.map((session) =>
          this.conversationSummary(session)
        )
        return { folders: [], stats: this.statsFor(conversations) } as T
      }
      default:
        return this.localUnsupported(command) as T
    }
  }

  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    void event
    void handler
    return () => {}
  }

  isDesktop(): boolean {
    return false
  }

  onReconnect(callback: () => void): UnsubscribeFn {
    this.reconnectListeners.add(callback)
    return () => this.reconnectListeners.delete(callback)
  }

  private notifyReconnect(): void {
    for (const listener of this.reconnectListeners) {
      try {
        listener()
      } catch {
        // One consumer failing to refresh must not block SSE recovery or
        // other global listeners such as the sidebar conversation list.
      }
    }
  }

  waitForReady(): Promise<void> {
    return Promise.resolve()
  }

  eventStream(): EventStream {
    return this.stream
  }

  destroy(): void {
    this.destroyed = true
    this.lifetime.abort()
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
    if (this.destroyed || this.lifetime.signal.aborted) {
      throw destroyedError()
    }
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? REQUEST_TIMEOUT_MS
    )
    const abortFromDestroy = () => controller.abort()
    this.lifetime.signal.addEventListener("abort", abortFromDestroy)
    let response: Response
    try {
      try {
        response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            Authorization: `Bearer ${this.config.token}`,
            ...init.headers,
          },
          signal: controller.signal,
        })
      } catch (error) {
        if (this.destroyed || this.lifetime.signal.aborted) {
          throw destroyedError()
        }
        throw error
      }
      if (this.destroyed || this.lifetime.signal.aborted) {
        throw destroyedError()
      }
      if (response.status === 401) this.config.onUnauthorized?.()
      if (!response.ok) {
        const body = (await response
          .json()
          .catch(() => ({}))) as OpenABErrorBody
        if (this.destroyed || this.lifetime.signal.aborted) {
          throw destroyedError()
        }
        throw {
          code: response.status === 409 ? "turn_in_progress" : body.code,
          message: body.error ?? `HTTP ${response.status}`,
          status: response.status,
        }
      }
      if (!parseJson || response.status === 204) {
        if (this.destroyed || this.lifetime.signal.aborted) {
          throw destroyedError()
        }
        return undefined as T
      }
      const body = (await response.json()) as T
      if (this.destroyed || this.lifetime.signal.aborted) {
        throw destroyedError()
      }
      return body
    } finally {
      clearTimeout(timeout)
      this.lifetime.signal.removeEventListener("abort", abortFromDestroy)
    }
  }

  private async listSessions(
    options?: CallOptions
  ): Promise<OpenABSessionSnapshot[]> {
    const sessions = await this.request<OpenABSessionSnapshot[]>(
      "/api/v1/sessions",
      {},
      options
    )
    for (const session of sessions) {
      this.conversationIdForSession(session.session_id)
    }
    return sessions
  }

  private async getSession(
    sessionId: string,
    options?: CallOptions
  ): Promise<OpenABSessionSnapshot> {
    const session = await this.request<OpenABSessionSnapshot>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      {},
      options
    )
    this.conversationIdForSession(session.session_id)
    return session
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

  private async createSession(
    options?: CallOptions
  ): Promise<OpenABSessionSnapshot> {
    const session = await this.request<OpenABSessionSnapshot>(
      "/api/v1/sessions",
      {
        method: "POST",
        body: JSON.stringify({ profile_id: this.config.profileId }),
      },
      options
    )
    this.conversationIdForSession(session.session_id)
    return session
  }

  private async claimOrCreateSession(options?: CallOptions): Promise<string> {
    const pending = this.pendingSessionIds.shift()
    if (pending) return pending
    return (await this.createSession(options)).session_id
  }

  private async loadLiveSnapshot(sessionId: string, eventSeq?: number) {
    const [session, transcript] = await Promise.all([
      this.getSession(sessionId),
      this.getTranscript(sessionId),
    ])
    return toLiveSessionSnapshot(
      session,
      transcript,
      this.conversationIdForSession(sessionId),
      eventSeq
    )
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
      default_agent_type: OPENAB_AGENT_TYPE,
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
      agent_type: OPENAB_AGENT_TYPE,
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

  private agentStatus(): AcpAgentStatus {
    return {
      agent_type: OPENAB_AGENT_TYPE,
      available: true,
      enabled: true,
      installed_version: OPENAB_AGENT_VERSION,
      is_acp_adapter: false,
    }
  }

  private agentInfo(): AcpAgentInfo {
    return {
      agent_type: OPENAB_AGENT_TYPE,
      skills_capable: false,
      registry_id: OPENAB_AGENT_TYPE,
      registry_version: null,
      supports_custom_version: false,
      name: "OpenAB",
      description: `OpenAB profile ${this.config.profileId}`,
      available: true,
      distribution_type: "remote",
      is_acp_adapter: false,
      custom_source: null,
      enabled: true,
      sort_order: 0,
      installed_version: OPENAB_AGENT_VERSION,
      env: {},
      host_tools_agent_mode: false,
      config_json: null,
      config_file_path: null,
      opencode_auth_json: null,
      codex_auth_json: null,
      codex_config_toml: null,
      codex_model_catalog: null,
      codex_sandbox_settings: null,
      cline_secrets_json: null,
      hermes_config_yaml: null,
      grok_config_toml: null,
      grok_settings: null,
      cursor_cli_config_json: null,
      cursor_settings: null,
      model_provider_id: null,
      icon_url: null,
    }
  }

  private conversationSummary(
    session: OpenABSessionSnapshot
  ): DbConversationSummary {
    return toConversationSummary(
      session,
      this.conversationIdForSession(session.session_id)
    )
  }

  private statsFor(conversations: DbConversationSummary[]): AgentStats {
    return {
      total_conversations: conversations.length,
      total_messages: conversations.reduce(
        (total, conversation) => total + conversation.message_count,
        0
      ),
      by_agent:
        conversations.length === 0
          ? []
          : [
              {
                agent_type: OPENAB_AGENT_TYPE,
                conversation_count: conversations.length,
              },
            ],
    }
  }

  private conversationIdForSession(sessionId: string): number {
    const existing = this.sessionToConversationId.get(sessionId)
    if (existing !== undefined) return existing

    const conversationId = this.nextConversationId
    this.nextConversationId += 1
    this.sessionToConversationId.set(sessionId, conversationId)
    this.conversationIdToSession.set(conversationId, sessionId)
    this.persistIdentities()
    return conversationId
  }

  private sessionIdForConversation(value: unknown): string {
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      const sessionId = this.conversationIdToSession.get(value)
      if (sessionId) return sessionId
    }
    if (typeof value === "string" && value) return value
    throw {
      code: "session_not_found",
      message: "session not found",
      status: 404,
    }
  }

  private restoreIdentities(): void {
    if (!this.storage) return
    try {
      const raw = this.storage.getItem(this.identityKey)
      if (!raw) return
      const state = JSON.parse(raw) as Partial<PersistedIdentityState>
      this.nextConversationId = Math.max(1, Number(state.nextId) || 1)
      for (const entry of state.entries ?? []) {
        if (
          typeof entry.sessionId !== "string" ||
          !Number.isSafeInteger(entry.conversationId) ||
          entry.conversationId <= 0
        ) {
          continue
        }
        this.sessionToConversationId.set(entry.sessionId, entry.conversationId)
        this.conversationIdToSession.set(entry.conversationId, entry.sessionId)
        this.nextConversationId = Math.max(
          this.nextConversationId,
          entry.conversationId + 1
        )
      }
    } catch {
      // Invalid local state is replaced when the first session is observed.
    }
  }

  private persistIdentities(): void {
    if (!this.storage) return
    const state: PersistedIdentityState = {
      nextId: this.nextConversationId,
      entries: [...this.sessionToConversationId].map(
        ([sessionId, conversationId]) => ({ sessionId, conversationId })
      ),
    }
    this.storage.setItem(this.identityKey, JSON.stringify(state))
  }

  private readOpenedTabs(): OpenedTabsSnapshot {
    if (!this.storage) return { version: 0, items: [] }
    try {
      const parsed = JSON.parse(
        this.storage.getItem(this.openedTabsKey) ?? '{"version":0,"items":[]}'
      ) as Partial<OpenedTabsSnapshot>
      return {
        version: Number(parsed.version) || 0,
        items: Array.isArray(parsed.items) ? parsed.items : [],
      }
    } catch {
      return { version: 0, items: [] }
    }
  }

  private saveOpenedTabs(args: Record<string, unknown>): SaveTabsOutcome {
    const current = this.readOpenedTabs()
    if (Number(args.expectedVersion) !== current.version) {
      return {
        accepted: false,
        version: current.version,
        tabs: current.items,
      }
    }
    const items = Array.isArray(args.items) ? (args.items as OpenedTab[]) : []
    const version = current.version + 1
    this.storage?.setItem(
      this.openedTabsKey,
      JSON.stringify({ version, items })
    )
    return { accepted: true, version, tabs: items }
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
      if (!this.destroyed && this.sseListeners.size > 0) {
        queueMicrotask(() => this.ensureSse())
      }
    })
  }

  private async runSse(): Promise<void> {
    let backoff = RECONNECT_INITIAL_MS
    while (!this.destroyed && this.sseListeners.size > 0) {
      this.sseController = new AbortController()
      try {
        const response = await this.fetchImpl(
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
        const final = parseSseChunk(buffer, `${decoder.decode()}\n\n`)
        for (const event of final.events) {
          if (event.id) this.lastEventId = event.id
          for (const subscriber of this.sseListeners) subscriber(event)
        }
      } catch (error) {
        if (
          this.destroyed ||
          (error &&
            typeof error === "object" &&
            (error as { name?: unknown }).name === "AbortError")
        ) {
          return
        }
      }
      if (this.destroyed || this.sseListeners.size === 0) return
      this.notifyReconnect()
      await new Promise((resolve) => setTimeout(resolve, backoff))
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    }
  }
}

function destroyedError() {
  return {
    code: "aborted",
    message: "OpenAB transport destroyed",
    status: 0,
  }
}
