// Tiered stale-while-revalidate cache with request coalescing.
//
//   L1  per-isolate memory (LRU)      — sub-millisecond, lost when the isolate is evicted
//   L2  Cloudflare Cache API          — shared by every isolate in the same data centre
//   L3  Workers KV (optional binding) — shared globally; lets a scheduled refresh in
//                                       one location feed visitors everywhere
//
// Read path:
//   fresh entry            -> HIT, no upstream call
//   stale entry            -> STALE: answer immediately, refresh in the background
//   nothing usable         -> MISS: wait for the loader (one loader per key, see below)
//   loader failed + stale  -> STALE-ERROR: keep serving what we have
//
// Failures are remembered for a short while (negative cache) so a struggling
// upstream is not hit again by every incoming request.

const WAITER_PATIENCE_MS = 12_000;

export class SwrCache {
  /**
   * @param {object} [options]
   * @param {() => number} [options.now]
   * @param {() => (Cache | null)} [options.edge]  lazily resolves the L2 cache
   * @param {string} [options.edgeOrigin]          origin used to build L2 cache keys
   * @param {number} [options.maxEntries]
   */
  constructor({ now = Date.now, edge = defaultEdge, edgeOrigin = "https://swr.cache", maxEntries = 300 } = {}) {
    this.now = now;
    this.edge = edge;
    this.edgeOrigin = edgeOrigin;
    this.maxEntries = maxEntries;
    /** @type {Map<string, { value: unknown, storedAt: number }>} */
    this.memory = new Map();
    /** @type {Map<string, Promise<{ value: unknown, storedAt: number }>>} */
    this.inflight = new Map();
    /** @type {Map<string, { error: unknown, at: number }>} */
    this.failures = new Map();
  }

  /**
   * @template T
   * @param {string} key
   * @param {{ ttlMs: number, staleMs: number, errorTtlMs?: number, kv?: KVNamespace | null }} policy
   * @param {() => Promise<T>} loader
   * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
   * @returns {Promise<{ value: T, state: "HIT" | "STALE" | "MISS" | "STALE-ERROR", tier: "memory" | "edge" | "kv" | "origin", ageMs: number, storedAt: number }>}
   */
  async get(key, policy, loader, ctx) {
    const { ttlMs, staleMs, errorTtlMs = 15_000, kv = null } = policy;

    let entry = this.#memoryGet(key);
    let tier = "memory";
    if (!entry || this.now() - entry.storedAt >= ttlMs) {
      const edgeEntry = await this.#edgeGet(key);
      if (edgeEntry && (!entry || edgeEntry.storedAt > entry.storedAt)) {
        entry = edgeEntry;
        tier = "edge";
        this.#memorySet(key, entry);
      }
    }
    if (kv && (!entry || this.now() - entry.storedAt >= ttlMs)) {
      const kvEntry = await this.#kvGet(kv, key);
      if (kvEntry && (!entry || kvEntry.storedAt > entry.storedAt)) {
        entry = kvEntry;
        tier = "kv";
        this.#memorySet(key, entry);
        ctx.waitUntil(this.#edgePut(key, entry, staleMs));
      }
    }

    const age = entry ? this.now() - entry.storedAt : Infinity;
    if (entry && age < ttlMs) {
      return { value: entry.value, state: "HIT", tier, ageMs: age, storedAt: entry.storedAt };
    }

    const failure = this.failures.get(key);
    const recentlyFailed = failure && this.now() - failure.at < errorTtlMs;

    if (entry && age < staleMs) {
      if (!recentlyFailed) {
        // Refresh behind the response. Errors are swallowed: the stale copy stays.
        ctx.waitUntil(this.#load(key, policy, loader, ctx).catch(() => {}));
      }
      return { value: entry.value, state: recentlyFailed ? "STALE-ERROR" : "STALE", tier, ageMs: age, storedAt: entry.storedAt };
    }

    if (recentlyFailed) throw failure.error;

    try {
      const loaded = await this.#load(key, policy, loader, ctx);
      return { value: loaded.value, state: "MISS", tier: "origin", ageMs: 0, storedAt: loaded.storedAt };
    } catch (error) {
      if (entry) return { value: entry.value, state: "STALE-ERROR", tier, ageMs: age, storedAt: entry.storedAt };
      throw error;
    }
  }

  /**
   * Load now regardless of freshness (used by the scheduled pre-warm).
   * @returns {Promise<{ value: unknown, storedAt: number }>}
   */
  refresh(key, policy, loader, ctx) {
    return this.#load(key, policy, loader, ctx);
  }

  /**
   * Single-flight loader: concurrent callers for the same key share one
   * upstream call instead of stampeding it.
   *
   * Workers caveat: a promise created by request A can stall for request B if
   * A's context is torn down first. The owner therefore pins its context with
   * waitUntil, and followers only wait a bounded time before loading themselves.
   */
  #load(key, policy, loader, ctx) {
    const existing = this.inflight.get(key);
    if (existing) {
      return Promise.race([
        existing,
        new Promise((resolve) => setTimeout(resolve, WAITER_PATIENCE_MS, null)),
      ]).then((result) => result ?? this.#run(key, policy, loader, ctx));
    }
    return this.#run(key, policy, loader, ctx);
  }

  #run(key, policy, loader, ctx) {
    const promise = (async () => {
      try {
        const value = await loader();
        const entry = { value, storedAt: this.now() };
        this.#memorySet(key, entry);
        this.failures.delete(key);
        ctx.waitUntil(this.#edgePut(key, entry, policy.staleMs));
        if (policy.kv) ctx.waitUntil(this.#kvPut(policy.kv, key, entry, policy.staleMs));
        return entry;
      } catch (error) {
        this.failures.set(key, { error, at: this.now() });
        throw error;
      } finally {
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    ctx.waitUntil(promise.catch(() => {}));
    return promise;
  }

  #memoryGet(key) {
    const entry = this.memory.get(key);
    if (!entry) return null;
    // Re-insert to mark as most recently used.
    this.memory.delete(key);
    this.memory.set(key, entry);
    return entry;
  }

  #memorySet(key, entry) {
    this.memory.delete(key);
    this.memory.set(key, entry);
    while (this.memory.size > this.maxEntries) {
      this.memory.delete(this.memory.keys().next().value);
    }
    if (this.failures.size > this.maxEntries) this.failures.clear();
  }

  #edgeRequest(key) {
    return new Request(`${this.edgeOrigin}/__swr/v1/${encodeURIComponent(key)}`);
  }

  async #edgeGet(key) {
    try {
      const edge = this.edge();
      if (!edge) return null;
      const response = await edge.match(this.#edgeRequest(key));
      if (!response) return null;
      const storedAt = Number(response.headers.get("x-stored-at"));
      if (!Number.isFinite(storedAt)) return null;
      return { value: await response.json(), storedAt };
    } catch {
      return null; // The cache is an optimisation; never fail a request over it.
    }
  }

  async #kvGet(kv, key) {
    try {
      const entry = await kv.get(key, "json");
      return entry && Number.isFinite(entry.storedAt) && "value" in entry ? entry : null;
    } catch {
      return null;
    }
  }

  async #kvPut(kv, key, entry, staleMs) {
    try {
      await kv.put(key, JSON.stringify(entry), { expirationTtl: Math.max(60, Math.ceil(staleMs / 1000)) });
    } catch {
      // ignore
    }
  }

  async #edgePut(key, entry, staleMs) {
    try {
      const edge = this.edge();
      if (!edge) return;
      const response = new Response(JSON.stringify(entry.value), {
        headers: {
          "content-type": "application/json",
          // Kept for the whole stale window; freshness is judged from x-stored-at.
          "cache-control": `public, max-age=${Math.max(1, Math.ceil(staleMs / 1000))}`,
          "x-stored-at": String(entry.storedAt),
        },
      });
      await edge.put(this.#edgeRequest(key), response);
    } catch {
      // ignore
    }
  }
}

function defaultEdge() {
  return typeof caches !== "undefined" && caches.default ? caches.default : null;
}
