import {
  DEFAULT_HUB_CAPABILITIES,
  HUB_CONTRACT_NAME,
  HUB_CONTRACT_VERSION,
  HUB_ENDPOINTS,
  HubAuthenticationError,
  HubCapabilityError,
  HubNetworkError,
  HubProtocolError,
  HubTransportError,
  HubVersionError,
  MemoryHubCredentialStore,
  normalizeHubBaseUrl,
  normalizeToken,
  resolveHubBaseUrl,
  type HubAcceptedCommand,
  type HubAuthListener,
  type HubAuthState,
  type HubCapabilities,
  type HubCapabilitiesInput,
  type HubCapability,
  type HubCreateSessionRequest,
  type HubCredentialStore,
  type HubEvent,
  type HubEventStream,
  type HubEventStreamOptions,
  type HubHealth,
  type HubRecoverySignal,
  type HubSessionListItem,
  type HubSessionSnapshot,
  type HubSocketEvent,
  type HubTransportClient,
  type HubTranscriptEntry,
  type HubTranscriptSnapshot,
  type HubWebSocketConnection,
  type HubWebSocketFactory,
  type HubWebSocketLike,
  type HubWebSocketOptions,
} from "./hub-contract"

export type HubFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>

export interface HubTransportOptions {
  baseUrl?: string
  token?: string | null
  credentialStore?: HubCredentialStore
  fetch?: HubFetch
  capabilities?: HubCapabilitiesInput
  capabilitiesPath?: string | null
  minimumContractVersion?: number
  webSocketFactory?: HubWebSocketFactory
}

interface RequestOptions {
  authenticated?: boolean
}

interface JsonResponseOptions<T> extends RequestOptions {
  parse: (value: unknown) => T
}

export interface HubSseRecord {
  id: string | null
  event: string
  data: string
}

type Unregister = () => void

const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5
const DEFAULT_RECONNECT_DELAY_MS = 500
const MAX_RECONNECT_DELAY_MS = 30_000
const WS_OPEN = 1
const WS_NORMAL_CLOSE = 1000
const WS_AUTH_EXPIRED = 4001
const WS_AUTH_FORBIDDEN = 4003

function cloneCapabilities(capabilities: HubCapabilities): HubCapabilities {
  return {
    contract: capabilities.contract,
    version: capabilities.version,
    features: { ...capabilities.features },
  }
}

function mergeCapabilities(
  input?: HubCapabilitiesInput | null
): HubCapabilities {
  return {
    contract: input?.contract ?? DEFAULT_HUB_CAPABILITIES.contract,
    version: input?.version ?? DEFAULT_HUB_CAPABILITIES.version,
    features: {
      ...DEFAULT_HUB_CAPABILITIES.features,
      ...input?.features,
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value
  return typeof value === "string" ? value : undefined
}

function parseSessionSnapshot(value: unknown): HubSessionSnapshot {
  if (!isRecord(value)) {
    throw new HubProtocolError("Hub session response must be an object")
  }

  const source = value.source
  if (
    !isRecord(source) ||
    !isNonEmptyString(source.platform) ||
    !isNonEmptyString(source.thread_id)
  ) {
    throw new HubProtocolError("Hub session source is invalid")
  }

  if (
    !isNonEmptyString(value.session_id) ||
    typeof value.agent !== "string" ||
    typeof value.workdir !== "string" ||
    typeof value.status !== "string" ||
    !isNonEmptyString(value.created_at) ||
    !isNonEmptyString(value.updated_at)
  ) {
    throw new HubProtocolError("Hub session snapshot is invalid")
  }

  const profileConfigErrors = value.profile_config_errors
  if (
    profileConfigErrors !== undefined &&
    (!Array.isArray(profileConfigErrors) ||
      profileConfigErrors.some(
        (item) =>
          !isRecord(item) ||
          !isNonEmptyString(item.config_id) ||
          typeof item.error !== "string"
      ))
  ) {
    throw new HubProtocolError("Hub profile configuration errors are invalid")
  }

  return {
    ...value,
    session_id: value.session_id,
    agent: value.agent,
    source: {
      ...source,
      platform: source.platform,
      thread_id: source.thread_id,
      permalink: optionalString(source.permalink),
    },
    workdir: value.workdir,
    profile_id: optionalString(value.profile_id),
    profile_name: optionalString(value.profile_name),
    profile_status: optionalString(value.profile_status),
    model: optionalString(value.model),
    reasoning_effort: optionalString(value.reasoning_effort),
    applied_provider: optionalString(value.applied_provider),
    metadata_source: optionalString(value.metadata_source),
    status: value.status,
    last_error: optionalString(value.last_error),
    profile_config_errors: profileConfigErrors
      ? profileConfigErrors.map((item) => ({
          config_id: (item as Record<string, unknown>).config_id as string,
          error: (item as Record<string, unknown>).error as string,
        }))
      : [],
    created_at: value.created_at,
    updated_at: value.updated_at,
    external_url: optionalString(value.external_url),
  }
}

function parseSessionList(value: unknown): HubSessionListItem[] {
  if (!Array.isArray(value)) {
    throw new HubProtocolError("Hub session list response must be an array")
  }

  return value.map((item) => {
    const snapshot = parseSessionSnapshot(item)
    const title = isRecord(item) ? optionalString(item.title) : undefined
    return { ...snapshot, title }
  })
}

function parseTranscriptEntry(value: unknown): HubTranscriptEntry {
  if (!isRecord(value)) {
    throw new HubProtocolError("Hub transcript entry must be an object")
  }
  if (
    !isNonEmptyString(value.entry_id) ||
    !isInteger(value.sequence) ||
    value.sequence < 0 ||
    (value.role !== "user" &&
      value.role !== "assistant" &&
      value.role !== "system" &&
      value.role !== "tool")
  ) {
    throw new HubProtocolError("Hub transcript entry is invalid")
  }
  if (
    value.content !== undefined &&
    value.content !== null &&
    typeof value.content !== "string"
  ) {
    throw new HubProtocolError("Hub transcript content is invalid")
  }

  return {
    ...value,
    entry_id: value.entry_id,
    sequence: value.sequence,
    role: value.role,
    content:
      value.content === undefined || value.content === null
        ? value.content
        : value.content,
    timestamp: optionalString(value.timestamp) ?? undefined,
    status: optionalString(value.status) ?? undefined,
    tool_call_id: optionalString(value.tool_call_id) ?? undefined,
  }
}

function parseTranscript(value: unknown): HubTranscriptSnapshot {
  if (!isRecord(value) || !isNonEmptyString(value.session_id)) {
    throw new HubProtocolError("Hub transcript response is invalid")
  }
  if (!Array.isArray(value.entries)) {
    throw new HubProtocolError("Hub transcript entries are invalid")
  }
  if (
    typeof value.overflowed !== "boolean" ||
    (value.oldest_sequence !== null && !isInteger(value.oldest_sequence)) ||
    !isInteger(value.next_sequence) ||
    !isNonEmptyString(value.stream_generation) ||
    !isInteger(value.stream_next_sequence)
  ) {
    throw new HubProtocolError("Hub transcript cursor is invalid")
  }

  return {
    ...value,
    session_id: value.session_id,
    entries: value.entries.map(parseTranscriptEntry),
    overflowed: value.overflowed,
    oldest_sequence: value.oldest_sequence,
    next_sequence: value.next_sequence,
    stream_generation: value.stream_generation,
    stream_next_sequence: value.stream_next_sequence,
  }
}

function parseAcceptedCommand(value: unknown): HubAcceptedCommand {
  if (
    !isRecord(value) ||
    value.accepted !== true ||
    !isNonEmptyString(value.session_id)
  ) {
    throw new HubProtocolError("Hub command response is invalid")
  }
  return {
    ...value,
    accepted: true,
    session_id: value.session_id,
  }
}

function parseCapabilities(value: unknown): HubCapabilities {
  const payload =
    isRecord(value) && isRecord(value.capabilities) ? value.capabilities : value
  if (
    !isRecord(payload) ||
    !isNonEmptyString(payload.contract) ||
    !isInteger(payload.version) ||
    payload.version < 1
  ) {
    throw new HubProtocolError("Hub capabilities response is invalid")
  }

  const features = payload.features
  if (features !== undefined && !isRecord(features)) {
    throw new HubProtocolError("Hub capability features are invalid")
  }

  const merged = mergeCapabilities({
    contract: payload.contract,
    version: payload.version,
    features: features as HubCapabilitiesInput["features"],
  })

  for (const [name, enabled] of Object.entries(merged.features)) {
    if (features && name in features && typeof features[name] !== "boolean") {
      throw new HubProtocolError(`Hub capability ${name} must be boolean`)
    }
    if (typeof enabled !== "boolean") {
      throw new HubProtocolError(`Hub capability ${name} must be boolean`)
    }
  }
  return merged
}

function parseHealth(text: string): HubHealth {
  const trimmed = text.trim()
  if (trimmed === "ok") {
    return { ok: true, status: "ok", version: null, capabilities: null }
  }

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch (error) {
    throw new HubProtocolError("Hub health response is not valid JSON", {
      cause: error,
    })
  }
  if (!isRecord(value)) {
    throw new HubProtocolError("Hub health response must be an object")
  }

  const rawStatus = value.status
  const status =
    rawStatus === "healthy" || rawStatus === "ok"
      ? "ok"
      : rawStatus === "degraded"
        ? "degraded"
        : rawStatus === "unhealthy"
          ? "unhealthy"
          : typeof value.ok === "boolean" && value.ok
            ? "ok"
            : "unhealthy"
  const capabilities = value.capabilities
    ? parseCapabilities(value.capabilities)
    : null
  const version =
    typeof value.version === "string"
      ? value.version
      : typeof value.version === "number"
        ? String(value.version)
        : null

  return {
    ok: typeof value.ok === "boolean" ? value.ok : status === "ok",
    status,
    version,
    capabilities,
  }
}

function statusCodeToErrorCode(
  status: number
):
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "server_error"
  | "service_unavailable" {
  if (status === 400) return "invalid_request"
  if (status === 404) return "not_found"
  if (status === 409) return "conflict"
  if (status === 503) return "service_unavailable"
  return "server_error"
}

function isAbortError(error: unknown): boolean {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  )
}

function errorMessageFromBody(
  body: string,
  token: string | null
): string | null {
  const trimmed = body.trim()
  if (!trimmed) return null

  let message: unknown = trimmed
  try {
    const parsed = JSON.parse(trimmed)
    if (isRecord(parsed) && typeof parsed.error === "string") {
      message = parsed.error
    }
  } catch {
    // Keep the bounded text response as the diagnostic.
  }

  if (typeof message !== "string") return null
  const redacted = token ? message.split(token).join("[redacted]") : message
  return redacted.slice(0, 500)
}

function normalizeTransportError(error: unknown): HubTransportError {
  if (error instanceof HubTransportError) return error
  if (isAbortError(error)) {
    return new HubTransportError("request_aborted", "Hub request was aborted")
  }
  return new HubNetworkError("Unable to reach the Hub", { cause: error })
}

function parseWebSocketMessage(data: unknown): HubEvent {
  let parsed: unknown = data
  if (typeof data === "string") {
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new HubProtocolError("Hub WebSocket message is not valid JSON")
    }
  }

  if (
    isRecord(parsed) &&
    typeof parsed.event === "string" &&
    "data" in parsed
  ) {
    return {
      id: typeof parsed.id === "string" ? parsed.id : null,
      event: parsed.event,
      data: parsed.data,
    }
  }

  return { id: null, event: "message", data: parsed }
}

function recoveryForEvent(event: HubEvent): HubRecoverySignal | null {
  if (event.event === "cursor_reset") {
    return { reason: "cursor_reset", event, action: "refetch_sessions" }
  }
  if (event.event !== "error" || !isRecord(event.data)) return null

  if (event.data.error === "event history unavailable") {
    return {
      reason: "history_unavailable",
      event,
      action: "refetch_sessions",
    }
  }
  if (event.data.error === "event stream lagged") {
    return {
      reason: "stream_lagged",
      event,
      action: "refetch_sessions",
    }
  }
  return null
}

function retryDelay(baseDelay: number, attempt: number): number {
  return Math.min(
    MAX_RECONNECT_DELAY_MS,
    baseDelay * 2 ** Math.min(Math.max(attempt - 1, 0), 5)
  )
}

/** Incremental parser for the server-sent event wire format. */
export class HubSseParser {
  private buffer = ""
  private event = ""
  private id: string | null = null
  private data: string[] = []

  feed(chunk: string, flush = false): HubSseRecord[] {
    this.buffer += chunk
    const records: HubSseRecord[] = []

    while (true) {
      const line = this.takeLine(flush)
      if (line === null) break
      this.consumeLine(line, records)
    }

    if (flush && this.buffer.length > 0) {
      const line = this.buffer
      this.buffer = ""
      this.consumeLine(line, records)
    }
    if (flush) this.dispatchRecord(records)

    return records
  }

  private takeLine(flush: boolean): string | null {
    let index = -1
    let separatorLength = 1
    for (let i = 0; i < this.buffer.length; i += 1) {
      const character = this.buffer[i]
      if (character === "\n") {
        index = i
        break
      }
      if (character === "\r") {
        if (i === this.buffer.length - 1 && !flush) return null
        index = i
        separatorLength = this.buffer[i + 1] === "\n" ? 2 : 1
        break
      }
    }
    if (index < 0) return null

    const line = this.buffer.slice(0, index)
    this.buffer = this.buffer.slice(index + separatorLength)
    return line
  }

  private consumeLine(line: string, records: HubSseRecord[]): void {
    if (line === "") {
      this.dispatchRecord(records)
      return
    }
    if (line.startsWith(":")) return

    const separator = line.indexOf(":")
    const field = separator === -1 ? line : line.slice(0, separator)
    const rawValue = separator === -1 ? "" : line.slice(separator + 1)
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue

    switch (field) {
      case "event":
        this.event = value
        break
      case "id":
        if (!value.includes("\0")) this.id = value
        break
      case "data":
        this.data.push(value)
        break
      default:
        break
    }
  }

  private dispatchRecord(records: HubSseRecord[]): void {
    if (this.data.length === 0 && !this.event && this.id === null) return
    records.push({
      id: this.id,
      event: this.event || "message",
      data: this.data.join("\n"),
    })
    this.event = ""
    this.id = null
    this.data = []
  }
}

interface FetchHubEventStreamDependencies {
  fetch: (lastEventId: string | null, signal: AbortSignal) => Promise<Response>
  unregister: Unregister
}

class FetchHubEventStream implements HubEventStream {
  private readonly controller = new AbortController()
  private readonly options: Required<
    Pick<
      HubEventStreamOptions,
      "reconnect" | "maxReconnectAttempts" | "reconnectDelayMs"
    >
  > &
    Omit<
      HubEventStreamOptions,
      "reconnect" | "maxReconnectAttempts" | "reconnectDelayMs"
    >
  private readonly dependencies: FetchHubEventStreamDependencies
  private readyResolve!: () => void
  private readyReject!: (error: unknown) => void
  private doneResolve!: () => void
  private doneReject!: (error: unknown) => void
  private readonly readyPromise: Promise<void>
  private readonly donePromise: Promise<void>
  private externalAbortListener: (() => void) | null = null
  private readySettled = false
  private doneSettled = false
  private closedValue = false
  private lastEventIdValue: string | null

  constructor(
    dependencies: FetchHubEventStreamDependencies,
    options: HubEventStreamOptions = {}
  ) {
    this.dependencies = dependencies
    this.options = {
      ...options,
      reconnect: options.reconnect ?? true,
      maxReconnectAttempts:
        options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS,
    }
    this.lastEventIdValue = options.lastEventId ?? null

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.donePromise = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve
      this.doneReject = reject
    })

    if (options.signal) {
      const abort = () => this.close()
      this.externalAbortListener = abort
      if (options.signal.aborted) {
        this.close()
      } else {
        options.signal.addEventListener("abort", abort, { once: true })
      }
    }

    void this.run()
  }

  get closed(): boolean {
    return this.closedValue
  }

  get lastEventId(): string | null {
    return this.lastEventIdValue
  }

  get ready(): Promise<void> {
    return this.readyPromise
  }

  get done(): Promise<void> {
    return this.donePromise
  }

  close(): void {
    if (this.closedValue) return
    this.finish()
  }

  private async run(): Promise<void> {
    let reconnectAttempts = 0

    while (!this.closedValue) {
      try {
        const response = await this.dependencies.fetch(
          this.lastEventIdValue,
          this.controller.signal
        )
        const contentType = response.headers.get("content-type")
        if (contentType && !contentType.includes("text/event-stream")) {
          throw new HubProtocolError(
            "Hub event stream returned an unexpected content type"
          )
        }
        if (!response.body) {
          throw new HubProtocolError("Hub event stream has no response body")
        }

        this.resolveReady()
        this.options.onOpen?.()
        await this.consume(response.body)
        if (this.closedValue) return

        if (
          !this.options.reconnect ||
          reconnectAttempts >= this.maxAttempts()
        ) {
          this.finish()
          return
        }
      } catch (error) {
        if (this.closedValue || isAbortError(error)) return
        const normalized = normalizeTransportError(error)
        this.options.onError?.(normalized)
        if (
          !this.options.reconnect ||
          !normalized.retryable ||
          reconnectAttempts >= this.maxAttempts()
        ) {
          this.finish(normalized)
          return
        }
      }

      reconnectAttempts += 1
      await this.waitBeforeReconnect(
        retryDelay(this.delay(), reconnectAttempts)
      )
    }
  }

  private maxAttempts(): number {
    return Math.max(0, Math.floor(this.options.maxReconnectAttempts))
  }

  private delay(): number {
    return Math.max(0, this.options.reconnectDelayMs)
  }

  private async waitBeforeReconnect(milliseconds: number): Promise<void> {
    if (milliseconds === 0 || this.closedValue) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, milliseconds)
      this.controller.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const parser = new HubSseParser()
    const decoder = new TextDecoder()
    try {
      while (!this.closedValue) {
        const result = await reader.read()
        if (result.done) break
        const records = parser.feed(
          decoder.decode(result.value, { stream: true })
        )
        this.handleRecords(records)
      }
      const records = parser.feed(decoder.decode(), true)
      this.handleRecords(records)
    } finally {
      reader.releaseLock()
    }
  }

  private handleRecords(records: HubSseRecord[]): void {
    for (const record of records) {
      if (record.id !== null) this.lastEventIdValue = record.id
      let data: unknown = null
      if (record.data.length > 0) {
        try {
          data = JSON.parse(record.data)
        } catch (error) {
          throw new HubProtocolError("Hub event data is not valid JSON", {
            cause: error,
          })
        }
      }
      const event: HubEvent = {
        id: record.id,
        event: record.event,
        data,
      }
      this.options.onEvent?.(event)
      const recovery = recoveryForEvent(event)
      if (recovery) this.options.onRecovery?.(recovery)
    }
  }

  private resolveReady(): void {
    if (this.readySettled) return
    this.readySettled = true
    this.readyResolve()
  }

  private finish(error?: HubTransportError): void {
    if (this.closedValue) return
    this.closedValue = true
    this.controller.abort()
    this.dependencies.unregister()
    if (this.externalAbortListener) {
      // The signal is optional and may have been aborted before registration.
      // Removing an absent listener is harmless in browser implementations.
      this.options.signal?.removeEventListener(
        "abort",
        this.externalAbortListener
      )
      this.externalAbortListener = null
    }

    if (!this.readySettled) {
      this.readySettled = true
      if (error) this.readyReject(error)
      else this.readyResolve()
    }
    if (!this.doneSettled) {
      this.doneSettled = true
      if (error) this.doneReject(error)
      else this.doneResolve()
    }
    this.options.onClose?.()
  }
}

class ManagedHubWebSocket implements HubWebSocketConnection {
  private readonly raw: HubWebSocketLike
  private readonly options: HubWebSocketOptions
  private readonly unregister: Unregister
  private readonly onAuthFailure: (code: number) => void
  private closedValue = false
  private externalAbortListener: (() => void) | null = null

  constructor(
    raw: HubWebSocketLike,
    options: HubWebSocketOptions,
    unregister: Unregister,
    onAuthFailure: (code: number) => void
  ) {
    this.raw = raw
    this.options = options
    this.unregister = unregister
    this.onAuthFailure = onAuthFailure
    raw.addEventListener("open", this.handleOpen)
    raw.addEventListener("message", this.handleMessage)
    raw.addEventListener("error", this.handleError)
    raw.addEventListener("close", this.handleClose)

    if (options.signal) {
      const abort = () => this.close()
      this.externalAbortListener = abort
      if (options.signal.aborted) abort()
      else options.signal.addEventListener("abort", abort, { once: true })
    }
  }

  get closed(): boolean {
    return this.closedValue
  }

  get readyState(): number {
    return this.raw.readyState
  }

  send(data: string | unknown): void {
    if (this.closedValue || this.raw.readyState !== WS_OPEN) {
      throw new HubTransportError("network_error", "Hub WebSocket is not open")
    }
    let payload: string
    if (typeof data === "string") {
      payload = data
    } else {
      try {
        payload = JSON.stringify(data)
      } catch (error) {
        throw new HubProtocolError(
          "Hub WebSocket payload is not serializable",
          {
            cause: error,
          }
        )
      }
    }
    this.raw.send(payload)
  }

  close(code = WS_NORMAL_CLOSE, reason = ""): void {
    if (this.closedValue) return
    this.raw.close(code, reason)
    this.finish(code, reason)
  }

  private readonly handleOpen = (): void => {
    if (!this.closedValue) this.options.onOpen?.()
  }

  private readonly handleMessage = (event: HubSocketEvent): void => {
    if (this.closedValue) return
    try {
      this.options.onMessage?.(parseWebSocketMessage(event.data))
    } catch (error) {
      const normalized = normalizeTransportError(error)
      this.options.onError?.(normalized)
    }
  }

  private readonly handleError = (): void => {
    if (!this.closedValue) {
      this.options.onError?.(
        new HubNetworkError("Hub WebSocket connection failed")
      )
    }
  }

  private readonly handleClose = (event: HubSocketEvent): void => {
    if (this.closedValue) return
    const code = event.code ?? WS_NORMAL_CLOSE
    const reason = typeof event.reason === "string" ? event.reason : ""
    if (code === WS_AUTH_EXPIRED || code === WS_AUTH_FORBIDDEN) {
      this.onAuthFailure(code)
    }
    this.finish(code, reason)
  }

  private finish(code: number, reason: string): void {
    if (this.closedValue) return
    this.closedValue = true
    this.unregister()
    for (const type of ["open", "message", "error", "close"] as const) {
      const listener =
        type === "open"
          ? this.handleOpen
          : type === "message"
            ? this.handleMessage
            : type === "error"
              ? this.handleError
              : this.handleClose
      this.raw.removeEventListener(type, listener)
    }
    if (this.externalAbortListener) {
      this.options.signal?.removeEventListener(
        "abort",
        this.externalAbortListener
      )
      this.externalAbortListener = null
    }
    this.options.onClose?.(code, reason)
  }
}

function browserWebSocketFactory(
  url: string,
  protocols?: string[]
): HubWebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new HubCapabilityError("websocket", "WebSocket is not available")
  }
  return new WebSocket(url, protocols) as unknown as HubWebSocketLike
}

export class HubTransport implements HubTransportClient {
  readonly baseUrl: string
  private readonly fetchImpl: HubFetch
  private readonly credentialStore: HubCredentialStore
  private readonly minimumContractVersion: number
  private readonly capabilitiesPath: string | null
  private readonly webSocketFactory: HubWebSocketFactory
  private capabilitiesValue: HubCapabilities
  private capabilitiesLoaded = false
  private token: string | null
  private authStateValue: HubAuthState
  private readonly authListeners = new Set<HubAuthListener>()
  private readonly eventStreams = new Set<HubEventStream>()
  private readonly sockets = new Set<HubWebSocketConnection>()

  constructor(options: HubTransportOptions = {}) {
    this.baseUrl =
      options.baseUrl !== undefined
        ? normalizeHubBaseUrl(options.baseUrl)
        : resolveHubBaseUrl()
    const globalFetch: HubFetch | undefined =
      typeof fetch === "function"
        ? (input, init) => fetch(input, init)
        : undefined
    const fetchImpl = options.fetch ?? globalFetch
    if (!fetchImpl) {
      throw new HubTransportError(
        "configuration_invalid",
        "Fetch is not available in this environment"
      )
    }
    this.fetchImpl = fetchImpl
    this.credentialStore =
      options.credentialStore ?? new MemoryHubCredentialStore()
    this.token =
      normalizeToken(options.token) ??
      normalizeToken(this.credentialStore.get())
    if (this.token) this.credentialStore.set(this.token)
    this.minimumContractVersion = Math.max(
      1,
      Math.floor(options.minimumContractVersion ?? HUB_CONTRACT_VERSION)
    )
    this.capabilitiesPath = options.capabilitiesPath
      ? this.relativePath(options.capabilitiesPath)
      : null
    this.webSocketFactory = options.webSocketFactory ?? browserWebSocketFactory
    this.capabilitiesValue = mergeCapabilities(options.capabilities)
    this.authStateValue = this.token
      ? {
          status: "authenticated",
          authenticatedAt: Date.now(),
          error: null,
        }
      : {
          status: "logged_out",
          authenticatedAt: null,
          error: null,
        }
  }

  get authState(): HubAuthState {
    return { ...this.authStateValue }
  }

  getAuthState(): HubAuthState {
    return this.authState
  }

  onAuthStateChange(listener: HubAuthListener): () => void {
    this.authListeners.add(listener)
    return () => this.authListeners.delete(listener)
  }

  async login(token: string): Promise<void> {
    const normalized = normalizeToken(token)
    if (!normalized) {
      throw new HubAuthenticationError(
        "authentication_required",
        "A Hub token is required"
      )
    }

    if (
      normalized === this.token &&
      this.authStateValue.status === "authenticated"
    ) {
      return
    }

    this.closeConnections()
    this.setAuthState({
      status: "authenticating",
      authenticatedAt: null,
      error: null,
    })
    try {
      this.credentialStore.set(normalized)
      this.token = normalized
      this.setAuthState({
        status: "authenticated",
        authenticatedAt: Date.now(),
        error: null,
      })
    } catch (error) {
      this.credentialStore.clear()
      this.token = null
      const authError = new HubAuthenticationError(
        "authentication_failed",
        "Unable to store Hub credentials",
        undefined
      )
      this.setAuthState({
        status: "logged_out",
        authenticatedAt: null,
        error: authError,
      })
      throw new HubTransportError("authentication_failed", authError.message, {
        cause: error,
      })
    }
  }

  async logout(): Promise<void> {
    this.closeConnections()
    this.credentialStore.clear()
    this.token = null
    this.setAuthState({
      status: "logged_out",
      authenticatedAt: null,
      error: null,
    })
  }

  async getHealth(): Promise<HubHealth> {
    const response = await this.requestRaw(
      HUB_ENDPOINTS.health,
      {},
      { authenticated: false }
    )
    const body = await this.readText(response)
    return parseHealth(body)
  }

  async getCapabilities(): Promise<HubCapabilities> {
    if (this.capabilitiesLoaded)
      return cloneCapabilities(this.capabilitiesValue)

    let capabilities: HubCapabilities
    if (this.capabilitiesPath) {
      capabilities = await this.requestJson(
        this.capabilitiesPath,
        {},
        {
          authenticated: false,
          parse: parseCapabilities,
        }
      )
    } else {
      const health = await this.getHealth()
      capabilities = health.capabilities
        ? health.capabilities
        : cloneCapabilities(this.capabilitiesValue)
    }

    this.validateCapabilities(capabilities)
    this.capabilitiesValue = cloneCapabilities(capabilities)
    this.capabilitiesLoaded = true
    return cloneCapabilities(this.capabilitiesValue)
  }

  hasCapability(capability: HubCapability): boolean {
    return this.capabilitiesValue.features[capability]
  }

  assertCapability(capability: HubCapability): void {
    if (!this.hasCapability(capability)) {
      throw new HubCapabilityError(capability)
    }
  }

  async listSessions(): Promise<HubSessionListItem[]> {
    this.assertCapability("sessions.read")
    return this.requestJson(
      HUB_ENDPOINTS.listSessions,
      {},
      { parse: parseSessionList }
    )
  }

  async createSession(
    request: HubCreateSessionRequest
  ): Promise<HubSessionSnapshot> {
    this.assertCapability("sessions.create")
    const profileId = request.profile_id?.trim()
    if (!profileId) {
      throw new HubTransportError(
        "invalid_request",
        "A profile_id is required to create a Hub session"
      )
    }
    return this.requestJson(
      HUB_ENDPOINTS.createSession,
      {
        method: "POST",
        body: JSON.stringify({
          ...request,
          profile_id: profileId,
        }),
      },
      { parse: parseSessionSnapshot }
    )
  }

  async getSession(sessionId: string): Promise<HubSessionSnapshot> {
    this.assertCapability("sessions.detail")
    return this.requestJson(
      HUB_ENDPOINTS.session(this.requireSessionId(sessionId)),
      {},
      { parse: parseSessionSnapshot }
    )
  }

  async getTranscript(
    sessionId: string,
    after?: number
  ): Promise<HubTranscriptSnapshot> {
    this.assertCapability("transcript.read")
    if (after !== undefined && (!isInteger(after) || after < 0)) {
      throw new HubTransportError(
        "invalid_request",
        "Transcript cursor must be a non-negative integer"
      )
    }
    const path = HUB_ENDPOINTS.transcript(this.requireSessionId(sessionId))
    const query =
      after === undefined ? "" : `?after=${encodeURIComponent(after)}`
    return this.requestJson(`${path}${query}`, {}, { parse: parseTranscript })
  }

  async sendMessage(
    sessionId: string,
    text: string
  ): Promise<HubAcceptedCommand> {
    this.assertCapability("sessions.messages")
    const normalizedText = typeof text === "string" ? text.trim() : ""
    if (!normalizedText) {
      throw new HubTransportError("invalid_request", "Message text is required")
    }
    return this.requestJson(
      HUB_ENDPOINTS.messages(this.requireSessionId(sessionId)),
      {
        method: "POST",
        body: JSON.stringify({ text: normalizedText }),
      },
      { parse: parseAcceptedCommand }
    )
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.assertCapability("sessions.cancel")
    const response = await this.requestRaw(
      HUB_ENDPOINTS.cancel(this.requireSessionId(sessionId)),
      { method: "POST" },
      {}
    )
    if (response.status === 204) return

    const body = await this.readJson(response)
    if (body !== null) parseAcceptedCommand(body)
  }

  openEventStream(options: HubEventStreamOptions = {}): HubEventStream {
    this.assertCapability("sessions.events")
    this.requireAuthenticated()

    // eslint-disable-next-line prefer-const -- unregister may run during construction
    let stream: FetchHubEventStream
    const unregister = () => {
      if (stream) this.eventStreams.delete(stream)
    }
    stream = new FetchHubEventStream(
      {
        fetch: (lastEventId, signal) =>
          this.fetchEventStream(lastEventId, signal),
        unregister,
      },
      options
    )
    this.eventStreams.add(stream)
    return stream
  }

  openWebSocket(options: HubWebSocketOptions): HubWebSocketConnection {
    if (options.requireCapability !== false) {
      this.assertCapability("websocket")
    }
    if (options.requireAuthentication !== false) {
      this.requireAuthenticated()
    }
    const path = this.relativePath(options.path)
    const url = this.websocketUrl(path)
    let raw: HubWebSocketLike
    try {
      raw = this.webSocketFactory(url, options.protocols)
    } catch (error) {
      throw normalizeTransportError(error)
    }

    // eslint-disable-next-line prefer-const -- unregister may run during construction
    let socket: ManagedHubWebSocket
    const unregister = () => {
      if (socket) this.sockets.delete(socket)
    }
    socket = new ManagedHubWebSocket(raw, options, unregister, (code) =>
      this.handleSocketAuthFailure(code)
    )
    this.sockets.add(socket)
    return socket
  }

  async close(): Promise<void> {
    await this.logout()
  }

  private async fetchEventStream(
    lastEventId: string | null,
    signal: AbortSignal
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "text/event-stream",
    }
    if (lastEventId) headers["Last-Event-ID"] = lastEventId
    return this.requestRaw(HUB_ENDPOINTS.sessionEvents, { headers, signal }, {})
  }

  private async requestJson<T>(
    path: string,
    init: RequestInit,
    options: JsonResponseOptions<T>
  ): Promise<T> {
    const response = await this.requestRaw(path, init, options)
    const body = await this.readJson(response)
    if (body === null) {
      throw new HubProtocolError("Hub response body is empty")
    }
    return options.parse(body)
  }

  private async requestRaw(
    path: string,
    init: RequestInit,
    options: RequestOptions = {}
  ): Promise<Response> {
    const authenticated = options.authenticated !== false
    if (authenticated) this.requireAuthenticated()

    const headers = new Headers(init.headers)
    headers.set("Accept", headers.get("Accept") ?? "application/json")
    if (init.body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    if (authenticated && this.token) {
      headers.set("Authorization", `Bearer ${this.token}`)
    }

    let response: Response
    try {
      response = await this.fetchImpl(this.url(path), {
        ...init,
        headers,
      })
    } catch (error) {
      if (isAbortError(error)) {
        throw new HubTransportError(
          "request_aborted",
          "Hub request was aborted"
        )
      }
      throw new HubNetworkError("Unable to reach the Hub", { cause: error })
    }

    if (response.status === 401 || response.status === 403) {
      const authError =
        response.status === 401
          ? new HubAuthenticationError(
              "authentication_failed",
              "Hub authentication expired",
              401
            )
          : new HubAuthenticationError(
              "forbidden",
              "Hub access is forbidden",
              403
            )
      this.invalidateAuthentication(authError)
      throw authError
    }

    if (!response.ok) {
      const body = await this.readText(response).catch(() => "")
      const message =
        errorMessageFromBody(body, this.token) ??
        `Hub request failed with status ${response.status}`
      throw new HubTransportError(
        statusCodeToErrorCode(response.status),
        message,
        {
          status: response.status,
          retryable: response.status === 503,
        }
      )
    }
    return response
  }

  private async readText(response: Response): Promise<string> {
    try {
      return await response.text()
    } catch (error) {
      throw new HubNetworkError("Unable to read the Hub response", {
        cause: error,
      })
    }
  }

  private async readJson(response: Response): Promise<unknown | null> {
    const body = await this.readText(response)
    if (!body.trim()) return null
    try {
      return JSON.parse(body)
    } catch (error) {
      throw new HubProtocolError("Hub response is not valid JSON", {
        cause: error,
      })
    }
  }

  private validateCapabilities(capabilities: HubCapabilities): void {
    if (capabilities.contract !== HUB_CONTRACT_NAME) {
      throw new HubTransportError(
        "version_incompatible",
        `Hub contract ${capabilities.contract} is not supported`
      )
    }
    if (capabilities.version < this.minimumContractVersion) {
      throw new HubVersionError(
        this.minimumContractVersion,
        capabilities.version
      )
    }
  }

  private requireAuthenticated(): void {
    if (this.token && this.authStateValue.status === "authenticated") return
    throw new HubAuthenticationError(
      "authentication_required",
      "Hub login is required"
    )
  }

  private requireSessionId(sessionId: string): string {
    if (!isNonEmptyString(sessionId)) {
      throw new HubTransportError("invalid_request", "A session ID is required")
    }
    return sessionId
  }

  private relativePath(path: string): string {
    const trimmed = path.trim()
    if (!trimmed || trimmed.startsWith("//")) {
      throw new HubTransportError(
        "configuration_invalid",
        "Hub endpoint path must be relative"
      )
    }
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol || parsed.host) {
        throw new HubTransportError(
          "configuration_invalid",
          "Hub endpoint path must be relative"
        )
      }
    } catch (error) {
      if (error instanceof HubTransportError) throw error
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  }

  private url(path: string): string {
    return `${this.baseUrl}${this.relativePath(path)}`
  }

  private websocketUrl(path: string): string {
    const url = this.url(path)
    return url.replace(/^http:/, "ws:").replace(/^https:/, "wss:")
  }

  private setAuthState(next: HubAuthState): void {
    this.authStateValue = next
    for (const listener of this.authListeners) listener(this.authState)
  }

  private invalidateAuthentication(error: HubAuthenticationError): void {
    this.credentialStore.clear()
    this.token = null
    this.closeConnections()
    this.setAuthState({
      status: error.code === "forbidden" ? "forbidden" : "expired",
      authenticatedAt: null,
      error,
    })
  }

  private handleSocketAuthFailure(code: number): void {
    const error =
      code === WS_AUTH_FORBIDDEN
        ? new HubAuthenticationError(
            "forbidden",
            "Hub access is forbidden",
            403
          )
        : new HubAuthenticationError(
            "authentication_failed",
            "Hub authentication expired",
            401
          )
    this.invalidateAuthentication(error)
  }

  private closeConnections(): void {
    for (const stream of Array.from(this.eventStreams)) stream.close()
    for (const socket of Array.from(this.sockets)) socket.close()
    this.eventStreams.clear()
    this.sockets.clear()
  }
}

export * from "./hub-contract"
