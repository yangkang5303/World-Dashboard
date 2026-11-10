/** In-memory stand-in for the Cloudflare Cache API. */
export class FakeEdgeCache {
  constructor() {
    this.store = new Map();
  }
  async match(request) {
    const hit = this.store.get(request.url);
    return hit ? hit.clone() : undefined;
  }
  async put(request, response) {
    this.store.set(request.url, response);
  }
}

/** Collects waitUntil promises so tests can settle background work. */
export class FakeContext {
  constructor() {
    this.pending = [];
  }
  waitUntil(promise) {
    this.pending.push(Promise.resolve(promise).catch(() => {}));
  }
  async settle() {
    while (this.pending.length) await Promise.all(this.pending.splice(0));
  }
}

/** In-memory stand-in for a Workers KV namespace. */
export class FakeKV {
  constructor() {
    this.store = new Map();
  }
  async get(key, type) {
    const raw = this.store.get(key);
    if (raw == null) return null;
    return type === "json" ? JSON.parse(raw) : raw;
  }
  async put(key, value) {
    this.store.set(key, value);
  }
}
