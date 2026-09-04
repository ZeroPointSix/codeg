import { describe, expect, it } from "vitest"
import {
  HubAuthenticationError,
  HubProtocolError,
  HubSseParser,
  HubTransport,
  MemoryHubCredentialStore,
  type HubFetch,
  type HubSocketEvent,
  type HubWebSocketLike,
} from "./hub-transport"
import { CODEG_HUB_CONTRACT_FIXTURE } from "./hub-contract-fixture"
import { MockHubTransport } from "./hub-transport-mock"

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function fixtureSnapshot(): Response {
  return jsonResponse(CODEG_HUB_CONTRACT_FIXTURE.snapshot)
}

class FakeWebSocket implements HubWebSocketLike {
  readyState = 1
  sent: string[] = []
  private readonly listeners = new Map<
    string,
    Set<(event: HubSocketEvent) => void>
  >()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ""): void {
    this.readyState = 3
    this.emit({ type: "close", code, reason })
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: HubSocketEvent) => void
  ): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: HubSocketEvent) => void
  ): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(event: HubSocketEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event)
    }
  }
}

describe("HubTransport", () => {
  it("uses a configured base URL and encodes opaque session IDs", async () => {
    let seenUrl = ""
    let seenHeaders: Headers | null = null
    const fetch: HubFetch = async (input, init) => {
      seenUrl = String(input)
      seenHeaders = new Headers(init?.headers)
      return fixtureSnapshot()
    }
    const transport = new HubTransport({
      baseUrl: "https://hub.example/openab/",
      token: "secret-token",
      fetch,
    })

    await transport.getSession("admin:fixture-session")

    expect(seenUrl).toBe(
      "https://hub.example/openab/api/v1/sessions/admin%3Afixture-session"
    )
    expect(seenUrl).not.toContain("secret-token")
    expect(seenHeaders!.get("Authorization")).toBe("Bearer secret-token")
  })

  it("clears credentials and exposes an expired state after a 401", async () => {
    const store = new MemoryHubCredentialStore()
    const states: string[] = []
    const fetch: HubFetch = async () =>
      jsonResponse({ error: "invalid or missing admin token" }, 401)
    const transport = new HubTransport({ fetch, credentialStore: store })

    await transport.login("secret-token")
    const unsubscribe = transport.onAuthStateChange((state) => {
      states.push(state.status)
    })

    await expect(transport.listSessions()).rejects.toMatchObject({
      code: "authentication_failed",
      status: 401,
    })

    unsubscribe()
    expect(store.get()).toBeNull()
    expect(transport.authState.status).toBe("expired")
    expect(transport.authState.error).toBeInstanceOf(HubAuthenticationError)
    expect(states).toEqual(["expired"])
    await expect(transport.listSessions()).rejects.toMatchObject({
      code: "authentication_required",
    })
  })

  it("rejects an incompatible capability version", async () => {
    const fetch: HubFetch = async () =>
      jsonResponse({
        contract: "codeg-openab-session",
        version: 1,
        features: {},
      })
    const transport = new HubTransport({
      fetch,
      capabilitiesPath: "/api/v1/capabilities",
      minimumContractVersion: 2,
    })

    await expect(transport.getCapabilities()).rejects.toMatchObject({
      code: "version_incompatible",
      expectedVersion: 2,
      actualVersion: 1,
    })
  })

  it("parses SSE records across chunks and line ending styles", () => {
    const parser = new HubSseParser()

    expect(
      parser.feed('id: generation:4\r\nevent: transcript\r\ndata: {"a":', false)
    ).toEqual([])
    expect(parser.feed('1}\r\ndata: {"b":2}\r\n\r\n', false)).toEqual([
      {
        id: "generation:4",
        event: "transcript",
        data: '{"a":1}\n{"b":2}',
      },
    ])
  })

  it("emits SSE recovery signals without using EventSource", async () => {
    const source = [
      'id: fixture-generation:1\nevent: transcript\ndata: {"ok":true}\n\n',
      'event: error\ndata: {"error":"event history unavailable"}\n\n',
    ].join("")
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(source))
        controller.close()
      },
    })
    const events: string[] = []
    const recoveryReasons: string[] = []
    const fetch: HubFetch = async () =>
      new Response(body, {
        headers: { "content-type": "text/event-stream" },
      })
    const transport = new HubTransport({ fetch, token: "secret-token" })
    const stream = transport.openEventStream({
      reconnect: false,
      onEvent: (event) => events.push(event.event),
      onRecovery: (signal) => recoveryReasons.push(signal.reason),
    })

    await stream.ready
    await stream.done

    expect(events).toEqual(["transcript", "error"])
    expect(recoveryReasons).toEqual(["history_unavailable"])
    expect(stream.lastEventId).toBe("fixture-generation:1")
  })

  it("keeps WS authentication out of the URL and manages its lifecycle", async () => {
    let seenUrl = ""
    let rawSocket: FakeWebSocket | null = null
    const messages: unknown[] = []
    const fetch: HubFetch = async () => new Response("ok")
    const transport = new HubTransport({
      fetch,
      token: "secret-token",
      capabilities: { features: { websocket: true } },
      webSocketFactory: (url) => {
        seenUrl = url
        rawSocket = new FakeWebSocket()
        return rawSocket
      },
    })
    const socket = transport.openWebSocket({
      path: "/api/v1/events",
      protocols: ["codeg.events.v1"],
      onMessage: (event) => messages.push(event.data),
    })

    rawSocket!.emit({
      type: "message",
      data: JSON.stringify({ event: "status_changed", data: { ok: true } }),
    })
    socket.send({ type: "ping" })

    expect(seenUrl).toBe("ws://localhost/api/v1/events")
    expect(seenUrl).not.toContain("secret-token")
    expect(rawSocket!.sent).toEqual(['{"type":"ping"}'])
    expect(messages).toEqual([{ ok: true }])

    socket.close()
    expect(socket.closed).toBe(true)
  })
})

describe("MockHubTransport", () => {
  it("implements the contract fixture and recovery callbacks", async () => {
    const transport = new MockHubTransport()
    await expect(transport.listSessions()).rejects.toMatchObject({
      code: "authentication_required",
    })

    await transport.login("fixture-token")
    const sessions = await transport.listSessions()
    const recoveryReasons: string[] = []
    const stream = transport.openEventStream({
      onRecovery: (signal) => recoveryReasons.push(signal.reason),
    })
    await stream.done

    expect(sessions[0]?.session_id).toBe("admin:fixture-session")
    expect(transport.calls.map((call) => call.path)).toContain(
      "/api/v1/sessions"
    )
    expect(recoveryReasons).toEqual([
      "cursor_reset",
      "history_unavailable",
      "stream_lagged",
    ])
  })

  it("reports malformed HTTP payloads as protocol errors", async () => {
    const fetch: HubFetch = async () => new Response("[]")
    const transport = new HubTransport({ fetch, token: "fixture-token" })

    await expect(
      transport.getSession("admin:fixture-session")
    ).rejects.toBeInstanceOf(HubProtocolError)
  })
})
