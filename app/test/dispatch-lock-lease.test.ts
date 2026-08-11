import { describe, expect, test } from "bun:test";

/**
 * Mirrors the CAS semantics of the Lua scripts in app/src/locks.ts
 * (RELEASE_DISPATCH_LOCK_IF_OWNER / RENEW_DAEMON_LOCK_IF_OWNER) and the
 * SET-NX behavior of tryAcquireDispatchLock / acquireDaemonInstanceLock.
 * Pure unit — no Valkey (the contract suite stays network-free; CI has no
 * Redis service). Keep in sync with app/src/locks.ts.
 */
interface Lease {
  token: string;
  expiresAt: number;
}

function tryAcquire(store: Map<string, Lease>, key: string, token: string, ttlMs: number, now: number): boolean {
  const existing = store.get(key);
  if (existing && existing.expiresAt > now) return false; // NX: still held
  store.set(key, { token, expiresAt: now + ttlMs });
  return true;
}

function releaseIfOwner(store: Map<string, Lease>, key: string, token: string): boolean {
  const existing = store.get(key);
  if (!existing || existing.token !== token) return false; // CAS miss: don't steal a re-claimed lease
  store.delete(key);
  return true;
}

function renewIfOwner(store: Map<string, Lease>, key: string, token: string, ttlMs: number, now: number): boolean {
  const existing = store.get(key);
  if (!existing || existing.token !== token) return false;
  existing.expiresAt = now + ttlMs;
  return true;
}

describe("dispatch/instance lock lease semantics", () => {
  test("second acquire is denied while the first lease is live (NX)", () => {
    const store = new Map<string, Lease>();
    expect(tryAcquire(store, "k", "token-a", 1000, 0)).toBe(true);
    expect(tryAcquire(store, "k", "token-b", 1000, 500)).toBe(false);
  });

  test("acquire succeeds again once the lease has expired", () => {
    const store = new Map<string, Lease>();
    tryAcquire(store, "k", "token-a", 1000, 0);
    expect(tryAcquire(store, "k", "token-b", 1000, 1500)).toBe(true);
  });

  test("release with the wrong token is a no-op — must not steal a lease re-claimed by another process", () => {
    const store = new Map<string, Lease>();
    tryAcquire(store, "k", "token-a", 1000, 0);
    tryAcquire(store, "k", "token-b", 1000, 1500); // expired, re-claimed by a different process
    expect(releaseIfOwner(store, "k", "token-a")).toBe(false);
    expect(store.get("k")?.token).toBe("token-b");
  });

  test("release with the owning token frees the key for the next acquire", () => {
    const store = new Map<string, Lease>();
    tryAcquire(store, "k", "token-a", 1000, 0);
    expect(releaseIfOwner(store, "k", "token-a")).toBe(true);
    expect(tryAcquire(store, "k", "token-b", 1000, 1)).toBe(true);
  });

  test("renew with the wrong token fails — instance already lost the lock to another daemon", () => {
    const store = new Map<string, Lease>();
    tryAcquire(store, "k", "token-a", 1000, 0);
    tryAcquire(store, "k", "token-b", 1000, 1500); // re-claimed after expiry
    expect(renewIfOwner(store, "k", "token-a", 1000, 1600)).toBe(false);
  });

  test("renew with the owning token extends the lease past its original TTL", () => {
    const store = new Map<string, Lease>();
    tryAcquire(store, "k", "token-a", 1000, 0);
    expect(renewIfOwner(store, "k", "token-a", 1000, 900)).toBe(true);
    // Without renewal the lease would have expired at t=1000.
    expect(tryAcquire(store, "k", "token-b", 1000, 1500)).toBe(false);
  });
});
