import {
  DEFAULT_HUB_CAPABILITIES,
  HubAuthenticationError,
  HubCapabilityError,
  HubTransportError,
  MemoryHubCredentialStore,
  encodeHubPathSegment,
  normalizeHubBaseUrl,
  normalizeToken,
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
  type HubTransportClient,
  type HubTranscriptSnapshot,
  type HubWebSocketConnection,
  type HubWebSocketOptions,
} from "./hub-contract"
import {
  CODEG_HUB_CONTRACT_FIXTURE,
  type HubContractFixture,
} from "./hub-contract-fixture"

export interface MockHubCall {
  method: "GET" | "POST"
  path: string
  body?: unknown
}

export interface MockHubTransportOptions {
  baseUrl?: string
  token?: string | null
  credentialStore?: HubCredentialStore
  capabilities?: HubCapabilitiesInput
  fixture?: HubContractFixture
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function mergeCapabilities(input?: HubCapabilitiesInput): HubCapabilities {
  return {
    contract: input?.contract ?? DEFAULT_HUB_CAPABILITIES.contract,
    version: input?.version ?? DEFAULT_HUB_CAPABILITIES.version,
    features: {
      ...DEFAULT_HUB_CAPABILITIES.features,
      ...input?.features,
    },
  }
}

function makeAuthState(
  token: string | null,
  status: HubAuthState["status"] = token ? "authenticated" : "logged_out"
): HubAuthState {
  return {
    status,
    authenticatedAt: token && status === "authenticated" ? Date.now() : null,
    error: null,
  }
}

class MockHubEventStream implements HubEventStream {
  private readonly options: HubEventStreamOptions
  private readonly events: HubEvent[]
  private readonly unregister: () => void
  private closedValue = false
  private lastEventIdValue: string | null
  private readonly donePromise: Promise<void>
  private doneResolve!: () => void

  readonly ready = Promise.resolve()

  constructor(
    events: HubEvent[],
    options: HubEventStreamOptions,
    unregister: () => void
  ) {
    this.events = events
    this.options = options
    this.unregister = unregister
    this.lastEventIdValue = options.lastEventId ?? null
    this.donePromise = new Promise((resolve) => {
      this.doneResolve = resolve
    })
    Promise.resolve().then(() => this.start())
  }

  get closed(): boolean {
    return this.closedValue
  }

  get lastEventId(): string | null {
    return this.lastEventIdValue
  }

  get done(): Promise<void> {
    return this.donePromise
  }

  close(): void {
    if (this.closedValue) return
    this.closedValue = true
    this.unregister()
    this.doneResolve()
    this.options.onClose?.()
  }

  private start(): void {
    if (this.closedValue) return
    this.options.onOpen?.()
    for (const event of this.events) {
      if (this.closedValue) return
      // A cursor_reset invalidates the previous generation, so it is always
      // delivered even when its sequence predates the resume cursor.
      if (
        event.event !== "cursor_reset" &&
        event.id &&
        !isAfterCursor(event.id, this.lastEventIdValue)
      )
        continue
      if (event.id) this.lastEventIdValue = event.id
      this.options.onEvent?.(clone(event))
      const recovery = recoveryForEvent(event)
      if (recovery) this.options.onRecovery?.(recovery)
    }
    this.close()
  }
}

class MockHubWebSocket implements HubWebSocketConnection {
  private readonly options: HubWebSocketOptions
  private readonly unregister: () => void
  private readonly onAuthFailure: () => void
  private closedValue = false
  private readyStateValue = 0

  constructor(
    options: HubWebSocketOptions,
    unregister: () => void,
    onAuthFailure: () => void
  ) {
    this.options = options
    this.unregister = unregister
    this.onAuthFailure = onAuthFailure
    Promise.resolve().then(() => {
      if (this.closedValue) return
      this.readyStateValue = 1
      this.options.onOpen?.()
    })
    if (options.signal) {
      if (options.signal.aborted) this.close()
      else
        options.signal.addEventListener("abort", this.handleAbort, {
          once: true,
        })
    }
  }

  get closed(): boolean {
    return this.closedValue
  }

  get readyState(): number {
    return this.readyStateValue
  }

  send(data: string | unknown): void {
    if (this.closedValue || this.readyStateValue !== 1) {
      throw new HubTransportError("network_error", "Hub WebSocket is not open")
    }
    if (typeof data !== "string") void JSON.stringify(data)
  }

  close(code = 1000, reason = ""): void {
    if (this.closedValue) return
    this.closedValue = true
    this.readyStateValue = 3
    this.unregister()
    this.options.signal?.removeEventListener("abort", this.handleAbort)
    this.options.onClose?.(code, reason)
  }

  private readonly handleAbort = (): void => this.close()

  triggerAuthFailure(): void {
    if (this.closedValue) return
    this.onAuthFailure()
    this.close(4001, "authentication expired")
  }
}

function isAfterCursor(id: string, cursor: string | null): boolean {
  if (!cursor) return true
  const idParts = id.split(":")
  const cursorParts = cursor.split(":")
  const idSequence = Number(idParts[idParts.length - 1])
  const cursorSequence = Number(cursorParts[cursorParts.length - 1])
  if (!Number.isFinite(idSequence) || !Number.isFinite(cursorSequence)) {
    return id !== cursor
  }
  return idSequence > cursorSequence
}

function recoveryForEvent(event: HubEvent): HubRecoverySignal | null {
  if (event.event === "cursor_reset") {
    return { reason: "cursor_reset", event, action: "refetch_sessions" }
  }
  if (
    event.event !== "error" ||
    !event.data ||
    typeof event.data !== "object"
  ) {
    return null
  }
  const error = (event.data as { error?: unknown }).error
  if (error === "event history unavailable") {
    return { reason: "history_unavailable", event, action: "refetch_sessions" }
  }
  if (error === "event stream lagged") {
    return { reason: "stream_lagged", event, action: "refetch_sessions" }
  }
  return null
}

export class MockHubTransport implements HubTransportClient {
  readonly baseUrl: string
  readonly calls: MockHubCall[] = []

  private readonly credentialStore: HubCredentialStore
  private readonly fixture: HubContractFixture
  private readonly authListeners = new Set<HubAuthListener>()
  private readonly streams = new Set<HubEventStream>()
  private readonly sockets = new Set<MockHubWebSocket>()
  private token: string | null
  private authStateValue: HubAuthState
  private capabilitiesValue: HubCapabilities

  constructor(options: MockHubTransportOptions = {}) {
    this.baseUrl = options.baseUrl
      ? normalizeHubBaseUrl(options.baseUrl)
      : "http://mock-hub"
    this.fixture = options.fixture ?? CODEG_HUB_CONTRACT_FIXTURE
    this.credentialStore =
      options.credentialStore ?? new MemoryHubCredentialStore()
    this.token = normalizeToken(
      options.token !== undefined ? options.token : this.credentialStore.get()
    )
    this.authStateValue = makeAuthState(this.token)
    this.capabilitiesValue = mergeCapabilities(options.capabilities)
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
    if (!isNonEmptyString(token)) {
      throw new HubAuthenticationError(
        "authentication_required",
        "A Hub token is required"
      )
    }
    this.closeConnections()
    this.credentialStore.set(token.trim())
    this.token = token.trim()
    this.setAuthState(makeAuthState(this.token))
  }

  async logout(): Promise<void> {
    this.closeConnections()
    this.credentialStore.clear()
    this.token = null
    this.setAuthState(makeAuthState(null))
  }

  async getHealth(): Promise<HubHealth> {
    this.calls.push({ method: "GET", path: "/health" })
    return {
      ok: true,
      status: "ok",
      version: "fixture",
      capabilities: clone(this.capabilitiesValue),
    }
  }

  async getCapabilities(): Promise<HubCapabilities> {
    return clone(this.capabilitiesValue)
  }

  hasCapability(capability: HubCapability): boolean {
    return this.capabilitiesValue.features[capability]
  }

  assertCapability(capability: HubCapability): void {
    if (!this.hasCapability(capability))
      throw new HubCapabilityError(capability)
  }

  async listSessions(): Promise<HubSessionListItem[]> {
    this.requireAuth()
    this.assertCapability("sessions.read")
    this.calls.push({ method: "GET", path: "/api/v1/sessions" })
    return [
      {
        ...clone(this.fixture.snapshot),
        title: "请检查当前变更并运行测试",
      },
    ]
  }

  async createSession(
    request: HubCreateSessionRequest
  ): Promise<HubSessionSnapshot> {
    this.requireAuth()
    this.assertCapability("sessions.create")
    this.calls.push({
      method: "POST",
      path: "/api/v1/sessions",
      body: clone(request),
    })
    if (!isNonEmptyString(request.profile_id)) {
      throw new HubTransportError("invalid_request", "profile_id is required", {
        status: 400,
      })
    }
    return clone(this.fixture.snapshot)
  }

  async getSession(sessionId: string): Promise<HubSessionSnapshot> {
    this.requireAuth()
    this.assertCapability("sessions.detail")
    this.calls.push({
      method: "GET",
      path: `/api/v1/sessions/${encodeHubPathSegment(sessionId)}`,
    })
    if (sessionId !== this.fixture.session_id) {
      throw new HubTransportError("not_found", "session not found", {
        status: 404,
      })
    }
    return clone(this.fixture.snapshot)
  }

  async getTranscript(
    sessionId: string,
    after?: number
  ): Promise<HubTranscriptSnapshot> {
    this.requireAuth()
    this.assertCapability("transcript.read")
    const suffix = after === undefined ? "" : `?after=${after}`
    this.calls.push({
      method: "GET",
      path: `/api/v1/sessions/${encodeHubPathSegment(sessionId)}/transcript${suffix}`,
    })
    if (sessionId !== this.fixture.session_id) {
      throw new HubTransportError("not_found", "session not found", {
        status: 404,
      })
    }
    return clone(this.fixture.transcript)
  }

  async sendMessage(
    sessionId: string,
    text: string
  ): Promise<HubAcceptedCommand> {
    this.requireAuth()
    this.assertCapability("sessions.messages")
    const normalizedText = typeof text === "string" ? text.trim() : ""
    this.calls.push({
      method: "POST",
      path: `/api/v1/sessions/${encodeHubPathSegment(sessionId)}/messages`,
      body: { text: normalizedText },
    })
    if (!normalizedText) {
      throw new HubTransportError("invalid_request", "text is required", {
        status: 400,
      })
    }
    if (sessionId !== this.fixture.session_id) {
      throw new HubTransportError("not_found", "session not found", {
        status: 404,
      })
    }
    return { accepted: true, session_id: sessionId }
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.requireAuth()
    this.assertCapability("sessions.cancel")
    this.calls.push({
      method: "POST",
      path: `/api/v1/sessions/${encodeHubPathSegment(sessionId)}/cancel`,
    })
    if (sessionId !== this.fixture.session_id) {
      throw new HubTransportError("not_found", "session not found", {
        status: 404,
      })
    }
  }

  openEventStream(options: HubEventStreamOptions = {}): HubEventStream {
    this.requireAuth()
    this.assertCapability("sessions.events")
    this.calls.push({ method: "GET", path: "/api/v1/sessions/events" })
    // eslint-disable-next-line prefer-const -- unregister may run during construction
    let stream: MockHubEventStream
    const unregister = () => {
      if (stream) this.streams.delete(stream)
    }
    stream = new MockHubEventStream(
      [...this.fixture.events, ...this.fixture.recovery_events],
      options,
      unregister
    )
    this.streams.add(stream)
    return stream
  }

  openWebSocket(options: HubWebSocketOptions): HubWebSocketConnection {
    if (options.requireCapability !== false) this.assertCapability("websocket")
    if (options.requireAuthentication !== false) this.requireAuth()
    // eslint-disable-next-line prefer-const -- unregister may run during construction
    let socket: MockHubWebSocket
    const unregister = () => {
      if (socket) this.sockets.delete(socket)
    }
    socket = new MockHubWebSocket(options, unregister, () => {
      this.invalidateAuth(
        new HubAuthenticationError(
          "authentication_failed",
          "Hub authentication expired",
          401
        )
      )
    })
    this.sockets.add(socket)
    return socket
  }

  async close(): Promise<void> {
    await this.logout()
  }

  private requireAuth(): void {
    if (this.token && this.authStateValue.status === "authenticated") return
    throw new HubAuthenticationError(
      "authentication_required",
      "Hub login is required"
    )
  }

  private setAuthState(state: HubAuthState): void {
    this.authStateValue = state
    for (const listener of this.authListeners) listener(this.authState)
  }

  private invalidateAuth(error: HubAuthenticationError): void {
    this.closeConnections()
    this.credentialStore.clear()
    this.token = null
    this.setAuthState({
      status: error.code === "forbidden" ? "forbidden" : "expired",
      authenticatedAt: null,
      error,
    })
  }

  private closeConnections(): void {
    for (const stream of Array.from(this.streams)) stream.close()
    for (const socket of Array.from(this.sockets)) socket.close()
    this.streams.clear()
    this.sockets.clear()
  }
}
