// GDELT DOC 2.0 client: bounded concurrency, per-attempt timeout, and
// retry with exponential backoff + jitter for rate limits and transient errors.
import { resolveGdeltCountryName } from "./countries.js";

export const DEFAULT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

const ATTEMPT_TIMEOUT_MS = 9_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1_000;
const MAX_RETRY_AFTER_MS = 8_000;
// GDELT rejects clients that send more than one request every five seconds.
export const MIN_INTERVAL_MS = 5_200;

export class GdeltError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: "rate-limit" | "upstream" | "timeout" | "query", retryable?: boolean, status?: number }} info
   */
  constructor(message, { kind, retryable = false, status }) {
    super(message);
    this.name = "GdeltError";
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
  }
}

/** Counting semaphore; waiters are served FIFO. */
export class Semaphore {
  constructor(limit) {
    this.free = limit;
    this.queue = [];
  }
  async run(task) {
    if (this.free > 0) this.free -= 1;
    else await new Promise((resolve) => this.queue.push(resolve));
    try {
      return await task();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

// One upstream request at a time per isolate, and never two starts closer
// together than MIN_INTERVAL_MS — retries included.
const upstreamSlots = new Semaphore(1);
let lastRequestAt = -Infinity;

async function waitForTurn(sleep, now) {
  const wait = lastRequestAt + MIN_INTERVAL_MS - now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = now();
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ docUrl?: string, translation?: string }} config
 * @param {{ query: string, timespan: string, maxRecords: number, sort?: string }} params
 * @param {{ fetchImpl?: typeof fetch, sleep?: (ms: number) => Promise<void>, now?: () => number }} [deps]
 * @returns {Promise<object[]>} raw GDELT article objects
 */
export async function fetchArticles(config, params, deps = {}) {
  const { fetchImpl = fetch, sleep = defaultSleep, now = Date.now } = deps;
  const url = new URL(config.docUrl || DEFAULT_DOC_URL);
  url.searchParams.set("query", params.query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("maxrecords", String(params.maxRecords));
  url.searchParams.set("timespan", params.timespan);
  url.searchParams.set("sort", params.sort || "DateDesc");
  if (config.translation) url.searchParams.set("trans", config.translation);

  return upstreamSlots.run(async () => {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        await waitForTurn(sleep, now);
        return await requestOnce(fetchImpl, url);
      } catch (error) {
        lastError = error;
        if (!(error instanceof GdeltError) || !error.retryable || attempt === MAX_ATTEMPTS - 1) break;
        // Extra delay on top of the mandatory spacing applied by waitForTurn.
        const backoff = BACKOFF_BASE_MS * 2 ** attempt;
        await sleep(Math.max(error.retryAfterMs ?? 0, backoff) + Math.random() * 400);
      }
    }
    throw lastError;
  });
}

async function requestOnce(fetchImpl, url) {
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { accept: "application/json", "user-agent": "world-dashboard-worker/1.0" },
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new GdeltError(timedOut ? "GDELT request timed out" : `GDELT unreachable: ${error?.message || error}`, {
      kind: timedOut ? "timeout" : "upstream",
      retryable: true,
    });
  }

  const text = await response.text();

  if (response.status === 429) {
    const error = new GdeltError("GDELT rate limit reached", { kind: "rate-limit", retryable: true, status: 429 });
    const retryAfter = Number(response.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.retryAfterMs = Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS);
    }
    throw error;
  }
  if (!response.ok) {
    throw new GdeltError(`GDELT responded with HTTP ${response.status}`, {
      kind: "upstream",
      retryable: response.status >= 500,
      status: response.status,
    });
  }

  let data;
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch {
    // GDELT reports problems as a plain-text body with HTTP 200.
    const snippet = text.trim().slice(0, 200);
    if (/limit requests|too many requests/i.test(snippet)) {
      throw new GdeltError("GDELT rate limit reached", { kind: "rate-limit", retryable: true, status: 429 });
    }
    throw new GdeltError(snippet || "Non-JSON response from GDELT", { kind: "query" });
  }

  if (data && data.status === "error") {
    throw new GdeltError(String(data.error || "Unknown GDELT error"), { kind: "query" });
  }
  return Array.isArray(data?.articles) ? data.articles : [];
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Convert raw GDELT articles to the API shape, dropping duplicates and junk. */
export function formatArticles(rawArticles) {
  const seenUrls = new Set();
  const seenTitles = new Set();
  const articles = [];

  for (const raw of rawArticles) {
    const url = text(raw?.url);
    // Only http(s) links ever reach the client.
    if (!url || !/^https?:\/\//i.test(url) || seenUrls.has(url)) continue;

    const title = (text(raw.title) || "Untitled").replace(/\s+/g, " ");
    // The same wire story is syndicated across many outlets; keep the first.
    const titleKey = title.toLowerCase();
    if (title !== "Untitled" && seenTitles.has(titleKey)) continue;

    seenUrls.add(url);
    seenTitles.add(titleKey);

    const country = resolveGdeltCountryName(raw.sourcecountry);
    articles.push({
      id: url,
      title,
      url,
      time: text(raw.seendate),
      source: text(raw.domain) || domainFromUrl(url),
      source_country: country?.iso2 ?? null,
      language: text(raw.language),
      image: text(raw.socialimage),
      countries: country ? [{ iso2: country.iso2, name: country.name }] : [],
    });
  }
  return articles;
}
