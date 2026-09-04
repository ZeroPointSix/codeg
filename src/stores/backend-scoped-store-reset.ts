// Registry of "reset to initial, backend-agnostic state" callbacks for the
// backend-scoped module singletons — the zustand stores that cache a SINGLE
// backend's folders / tabs / conversations. Each such store registers its reset
// here at import time; `RemoteConnectionGate` and OpenAB target switches call
// `resetBackendScopedStores()` when the backend identity changes.
//
// Scope: resets store STATE and bumps `backendScopeEpoch` so in-flight fetches
// that complete after the switch cannot re-commit stale data. Callers that await
// a backend request must capture the epoch before the await and call
// `isCurrentBackendScopeEpoch` before writing. OpenABTransport.destroy() also
// aborts in-flight REST, but epoch checks remain required for responses that
// already resolved.
//
// Why a registry instead of the gate importing each store's reset directly:
//   1. Bundle boundaries — `RemoteConnectionGate` is also mounted by the
//      git-operation windows (commit / stash / push / merge) and the settings
//      window, none of which load the workspace stores. Self-registration keeps
//      those per-window bundles free of the (large) store modules; a realm that
//      never imports a store never registers it, so the reset is a no-op
//      there rather than a static dependency.
//   2. The reset touches exactly the stores that actually exist in the current
//      realm, with no import-order or partial-mount assumptions.
//
// NOTE: the ACP-agents store is intentionally NOT registered here. Its reset
// tears down a ref-counted subscription and would corrupt the refcount if any
// consumer were still mounted. It is left out because it already self-manages via
// that refcount (cold-resetting when its last consumer unmounts), and a real
// in-place backend switcher must handle its refcount explicitly anyway — e.g. a
// remote→local switch would NOT pass through the gate's loading-state unmount, so
// registering a forced reset here could fire while consumers are still mounted.

type ResetFn = () => void

const resets = new Set<ResetFn>()
let backendScopeEpoch = 0

/** Register a store reset to run when the realm's backend identity changes. */
export function registerBackendScopedStoreReset(reset: ResetFn): void {
  resets.add(reset)
}

/** Epoch captured before an in-flight backend fetch; compare after it resolves. */
export function getBackendScopeEpoch(): number {
  return backendScopeEpoch
}

/** False when `resetBackendScopedStores()` ran after `epoch` was captured. */
export function isCurrentBackendScopeEpoch(epoch: number): boolean {
  return epoch === backendScopeEpoch
}

/**
 * Reset every backend-scoped store registered in THIS realm to its initial
 * state and invalidate in-flight fetches via the scope epoch. Called by
 * `RemoteConnectionGate` and OpenAB target switches when the backend identity
 * changes.
 */
export function resetBackendScopedStores(): void {
  backendScopeEpoch += 1
  for (const reset of resets) reset()
}

/** Test-only: drop all registered resets so each test starts from a clean set. */
export function __clearRegisteredBackendScopedStoreResets(): void {
  resets.clear()
}
