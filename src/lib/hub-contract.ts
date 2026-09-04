export const HUB_CONTRACT_NAME = "codeg-openab-session" as const
export const HUB_CONTRACT_VERSION = 1 as const

export const HUB_ENDPOINTS = {
  health: "/health",
  listSessions: "/api/v1/sessions",
  createSession: "/api/v1/sessions",
  sessionEvents: "/api/v1/sessions/events",
  session: (sessionId: string) =>
    `/api/v1/sessions/${encodeHubPathSegment(sessionId)}`,
  transcript: (sessionId: string) =>
    `/api/v1/sessions/${encodeHubPathSegment(sessionId)}/transcript`,
  messages: (sessionId: string) =>
    `/api/v1/sessions/${encodeHubPathSegment(sessionId)}/messages`,
  cancel: (sessionId: string) =>
    `/api/v1/sessions/${encodeHubPathSegment(sessionId)}/cancel`,
} as const

export type HubCapability =
  | "health"
  | "sessions.read"
  | "sessions.create"
  | "sessions.detail"
  | "transcript.read"
  | "sessions.events"
  | "sessions.messages"
  | "sessions.cancel"
  | "websocket"

export type HubCapabilityMap = Record<HubCapability, boolean>

export interface HubCapabilities {
  contract: string
  version: number
  features: HubCapabilityMap
}

export type HubCapabilitiesInput = Partial<
  Omit<HubCapabilities, "features">
> & {
  features?: Partial<HubCapabilityMap>
}

export const DEFAULT_HUB_CAPABILITIES: HubCapabilities = {
  contract: HUB_CONTRACT_NAME,
  version: HUB_CONTRACT_VERSION,
  features: {
    health: true,
    "sessions.read": true,
    "sessions.create": true,
    "sessions.detail": true,
    "transcript.read": true,
    "sessions.events": true,
    "sessions.messages": true,
    "sessions.cancel": true,
    websocket: false,
  },
}

export type HubHealthStatus = "ok" | "degraded" | "unhealthy"

export interface HubHealth {
  ok: boolean
  status: HubHealthStatus
  version: string | null
  capabilities: HubCapabilities | null
}

export type HubSessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "suspended"
  | "error"
  | "exited"
  | (string & {})

export type HubProfileStatus = "active" | "deleted" | (string & {})

export interface HubSessionSource {
  platform: string
  thread_id: string
  permalink?: string | null
}

export interface HubSessionSnapshot {
  session_id: string
  agent: string
  source: HubSessionSource
  workdir: string
  profile_id?: string | null
  profile_name?: string | null
  profile_status?: HubProfileStatus | null
  model?: string | null
  reasoning_effort?: string | null
  applied_provider?: string | null
  metadata_source?: "acp" | "configured" | (string & {}) | null
  status: HubSessionStatus
  last_error?: string | null
  profile_config_errors?: HubProfileConfigError[]
  created_at: string
  updated_at: string
  external_url?: string | null
}

export interface HubProfileConfigError {
  config_id: string
  error: string
}

export interface HubSessionListItem extends HubSessionSnapshot {
  title?: string | null
}

export interface HubSessionOverrides {
  working_dir?: string | null
  model?: string | null
  reasoning_effort?: string | null
  config_options?: Record<string, string>
}

export interface HubCreateSessionRequest {
  profile_id: string
  overrides?: HubSessionOverrides
}

export interface HubAcceptedCommand {
  accepted: boolean
  session_id: string
}

export type HubTranscriptRole = "user" | "assistant" | "system" | "tool"
export type HubTranscriptStatus =
  | "streaming"
  | "thinking"
  | "running"
  | "completed"
  | "failed"
  | (string & {})

export interface HubToolContent {
  type: "text" | (string & {})
  text?: string
  [key: string]: unknown
}

export interface HubToolCall {
  sessionUpdate?: "tool_call" | "tool_call_update" | (string & {})
  toolCallId?: string
  title?: string
  rawInput?: unknown
  content?: HubToolContent[]
  [key: string]: unknown
}

export interface HubToolResult {
  sessionUpdate?: "tool_call_update" | (string & {})
  toolCallId?: string
  title?: string
  rawInput?: unknown
  content?: HubToolContent[]
  [key: string]: unknown
}

export interface HubTranscriptEntry {
  entry_id: string
  sequence: number
  timestamp?: string
  role: HubTranscriptRole
  content?: string | null
  tool_call?: HubToolCall
  tool_result?: HubToolResult
  tool_call_id?: string
  status?: HubTranscriptStatus
  [key: string]: unknown
}

export interface HubTranscriptSnapshot {
  session_id: string
  entries: HubTranscriptEntry[]
  overflowed: boolean
  oldest_sequence: number | null
  next_sequence: number
  stream_generation: string
  stream_next_sequence: number
}

export interface HubTranscriptEventData {
  sequence: number
  session_id: string
  entry: HubTranscriptEntry
}

export interface HubLifecycleEventData {
  sequence: number
  event: string
  snapshot: HubSessionSnapshot
}

export interface HubCursorResetData {
  error: string
  last_event_generation?: string
  last_sequence?: number
  current_generation?: string
  action?: string
  [key: string]: unknown
}

export interface HubStreamErrorData {
  error: string
  action?: string
  [key: string]: unknown
}

export interface HubEvent<T = unknown> {
  id: string | null
  event: string
  data: T
}

export interface HubRecoverySignal {
  reason: "cursor_reset" | "history_unavailable" | "stream_lagged"
  event: HubEvent
  action: "refetch_sessions"
}

export interface HubCredentialStore {
  get(): string | null
  set(token: string): void
  clear(): void
}

export class MemoryHubCredentialStore implements HubCredentialStore {
  private token: string | null

  constructor(initialToken?: string | null) {
    this.token = normalizeToken(initialToken)
  }

  get(): string | null {
    return this.token
  }

  set(token: string): void {
    this.token = normalizeToken(token)
  }

  clear(): void {
    this.token = null
  }
}

export interface HubRuntimeConfig {
  hubBaseUrl?: string
}

export type HubErrorCode =
  | "configuration_invalid"
  | "network_error"
  | "protocol_error"
  | "capability_missing"
  | "version_incompatible"
  | "authentication_required"
  | "authentication_failed"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "server_error"
  | "service_unavailable"
  | "request_aborted"

export interface HubTransportErrorOptions {
  status?: number
  retryable?: boolean
  cause?: unknown
}

export class HubTransportError extends Error {
  readonly code: HubErrorCode
  readonly status: number | null
  readonly retryable: boolean

  constructor(
    code: HubErrorCode,
    message: string,
    options: HubTransportErrorOptions = {}
  ) {
    super(message)
    this.name = "HubTransportError"
    this.code = code
    this.status = options.status ?? null
    this.retryable = options.retryable ?? false
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: options.cause,
        writable: false,
      })
    }
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

export class HubNetworkError extends HubTransportError {
  constructor(message: string, options: HubTransportErrorOptions = {}) {
    super("network_error", message, { ...options, retryable: true })
    this.name = "HubNetworkError"
  }
}

export class HubProtocolError extends HubTransportError {
  constructor(message: string, options: HubTransportErrorOptions = {}) {
    super("protocol_error", message, options)
    this.name = "HubProtocolError"
  }
}

export class HubCapabilityError extends HubTransportError {
  readonly capability: HubCapability

  constructor(capability: HubCapability, message?: string) {
    super(
      "capability_missing",
      message ?? `Hub capability is not available: ${capability}`
    )
    this.name = "HubCapabilityError"
    this.capability = capability
  }
}

export class HubVersionError extends HubTransportError {
  readonly expectedVersion: number
  readonly actualVersion: number

  constructor(expectedVersion: number, actualVersion: number) {
    super(
      "version_incompatible",
      `Hub contract version ${actualVersion} is incompatible with ${expectedVersion}`
    )
    this.name = "HubVersionError"
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
  }
}

export class HubAuthenticationError extends HubTransportError {
  constructor(
    code: "authentication_required" | "authentication_failed" | "forbidden",
    message: string,
    status?: number
  ) {
    super(code, message, { status })
    this.name = "HubAuthenticationError"
  }
}

export interface HubAuthState {
  status:
    | "logged_out"
    | "authenticating"
    | "authenticated"
    | "expired"
    | "forbidden"
  authenticatedAt: number | null
  error: HubAuthenticationError | null
}

export type HubAuthListener = (state: HubAuthState) => void

export interface HubEventStreamOptions {
  lastEventId?: string | null
  signal?: AbortSignal
  reconnect?: boolean
  maxReconnectAttempts?: number
  reconnectDelayMs?: number
  onOpen?: () => void
  onEvent?: (event: HubEvent) => void
  onRecovery?: (signal: HubRecoverySignal) => void
  onError?: (error: HubTransportError) => void
  onClose?: () => void
}

export interface HubEventStream {
  readonly closed: boolean
  readonly lastEventId: string | null
  readonly ready: Promise<void>
  readonly done: Promise<void>
  close(): void
}

export type HubSocketEventType = "open" | "message" | "error" | "close"

export interface HubSocketEvent {
  type: HubSocketEventType
  data?: unknown
  code?: number
  reason?: string
}

export interface HubWebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(
    type: HubSocketEventType,
    listener: (event: HubSocketEvent) => void
  ): void
  removeEventListener(
    type: HubSocketEventType,
    listener: (event: HubSocketEvent) => void
  ): void
}

export type HubWebSocketFactory = (
  url: string,
  protocols?: string[]
) => HubWebSocketLike

export interface HubWebSocketOptions {
  path: string
  protocols?: string[]
  requireAuthentication?: boolean
  requireCapability?: boolean
  signal?: AbortSignal
  onOpen?: () => void
  onMessage?: (event: HubEvent) => void
  onError?: (error: HubTransportError) => void
  onClose?: (code: number, reason: string) => void
}

export interface HubWebSocketConnection {
  readonly closed: boolean
  readonly readyState: number
  close(code?: number, reason?: string): void
  send(data: string | unknown): void
}

export interface HubTransportClient {
  readonly baseUrl: string
  readonly authState: HubAuthState
  login(token: string): Promise<void>
  logout(): Promise<void>
  getAuthState(): HubAuthState
  onAuthStateChange(listener: HubAuthListener): () => void
  getHealth(): Promise<HubHealth>
  getCapabilities(): Promise<HubCapabilities>
  hasCapability(capability: HubCapability): boolean
  assertCapability(capability: HubCapability): void
  listSessions(): Promise<HubSessionListItem[]>
  createSession(request: HubCreateSessionRequest): Promise<HubSessionSnapshot>
  getSession(sessionId: string): Promise<HubSessionSnapshot>
  getTranscript(
    sessionId: string,
    after?: number
  ): Promise<HubTranscriptSnapshot>
  sendMessage(sessionId: string, text: string): Promise<HubAcceptedCommand>
  cancelSession(sessionId: string): Promise<void>
  openEventStream(options?: HubEventStreamOptions): HubEventStream
  openWebSocket(options: HubWebSocketOptions): HubWebSocketConnection
  close(): Promise<void>
}

export function normalizeToken(
  token: string | null | undefined
): string | null {
  if (typeof token !== "string") return null
  const normalized = token.trim()
  return normalized.length > 0 ? normalized : null
}

export function encodeHubPathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

export function normalizeHubBaseUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new HubTransportError(
      "configuration_invalid",
      "Hub base URL must not be empty"
    )
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch (error) {
    throw new HubTransportError(
      "configuration_invalid",
      "Hub base URL must be an absolute URL",
      { cause: error }
    )
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HubTransportError(
      "configuration_invalid",
      "Hub base URL must use HTTP or HTTPS"
    )
  }
  if (parsed.username || parsed.password) {
    throw new HubTransportError(
      "configuration_invalid",
      "Hub base URL must not contain credentials"
    )
  }
  if (parsed.search || parsed.hash) {
    throw new HubTransportError(
      "configuration_invalid",
      "Hub base URL must not contain a query or hash"
    )
  }

  const pathname = parsed.pathname.replace(/\/+$/, "")
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`
}

export function resolveHubBaseUrl(explicitBaseUrl?: string): string {
  const runtimeConfig = readRuntimeHubConfig()
  const browserOrigin =
    typeof window !== "undefined" && window.location
      ? window.location.origin
      : typeof globalThis !== "undefined" && "location" in globalThis
        ? (globalThis.location as Location).origin
        : null
  const candidate =
    explicitBaseUrl?.trim() ||
    runtimeConfig?.hubBaseUrl?.trim() ||
    browserOrigin

  return normalizeHubBaseUrl(candidate || "http://localhost")
}

function readRuntimeHubConfig(): HubRuntimeConfig | null {
  if (typeof globalThis === "undefined") return null
  const value = (
    globalThis as typeof globalThis & {
      __CODEG_CONFIG__?: unknown
    }
  ).__CODEG_CONFIG__
  if (!value || typeof value !== "object" || Array.isArray(value)) return null

  const hubBaseUrl = (value as { hubBaseUrl?: unknown }).hubBaseUrl
  return typeof hubBaseUrl === "string" ? { hubBaseUrl } : null
}
