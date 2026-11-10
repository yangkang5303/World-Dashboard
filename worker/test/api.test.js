import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { handleRequest, handleScheduled } from "../src/index.js";
import { FEED_KEYS, stampOf } from "../src/webfeed.js";
import { FakeContext, FakeKV } from "./helpers.js";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 10, 10, 7, 0);

const record = (n, host, lang = "en", minutesAgo = 10) => ({
  ID: n,
  date: new Date(NOW - minutesAgo * MINUTE).toISOString(),
  img: "https://img.example/a.jpg",
  lang,
  title: `Headline number ${n} from ${host}`,
  url: `https://${host}/news/2026/story-${n}-long-slug`,
});

/** Fake GDELT feed: files keyed by minute stamp, everything else 404s. */
function feed(files) {
  const requested = [];
  const fetchImpl = async (url) => {
    const stamp = /(\d{14})\.toc\.json\.gz$/.exec(url)[1];
    requested.push(stamp);
    const lines = files[stamp];
    if (lines instanceof Response) return lines;
    if (!lines) return new Response("not found", { status: 404 });
    const body = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
    return new Response(gzipSync(body));
  };
  return { requested, deps: { fetchImpl, now: () => NOW } };
}

// The worker caches per feed URL; a unique URL per test keeps tests apart.
let unique = 0;
const makeEnv = () => ({ NEWS_KV: new FakeKV(), GDELT_FEED_URL: `https://feed${++unique}.example` });

async function call(path, env, deps, init) {
  const ctx = new FakeContext();
  const response = await handleRequest(new Request(`https://dash.example${path}`, init), env, ctx, deps);
  await ctx.settle();
  return response;
}

const stampAgo = (minutes) => stampOf(NOW - minutes * MINUTE);

test("the scheduled run ingests feed files and visitors read the result", async () => {
  const { requested, deps } = feed({
    [stampAgo(20)]: [record(1, "spiegel.de", "de", 20), record(2, "nytimes.com"), record(3, "lemonde.fr", "fr")],
    [stampAgo(10)]: [record(4, "spiegel.de", "de"), "not json", record(5, "example.com", "en")],
  });
  const env = makeEnv();
  await handleScheduled(env, new FakeContext(), deps);

  // Backfills one run's worth of minutes; stops early once two files are in.
  assert.equal(requested[0], stampAgo(33));
  assert.equal(requested.at(-1), stampAgo(10));
  const stored = await env.NEWS_KV.get(FEED_KEYS.global, "json");
  assert.equal(stored.cursor, stampAgo(10));
  assert.deepEqual(stored.volumes, { DE: 2, US: 1, FR: 1 });

  const body = await (await call("/api/global", env, deps)).json();
  assert.equal(body.count, 4); // example.com/en cannot be placed on the map
  assert.equal(body.articles[0].source_country, "DE"); // the biggest publisher leads
  assert.deepEqual(body.articles[0].countries, [{ iso2: "DE", name: "Germany" }]);

  const de = await (await call("/api/country/DEU", env, deps)).json();
  assert.deepEqual(de.country, { iso2: "DE", name: "Germany" });
  assert.deepEqual(de.articles.map((a) => a.url), [record(4, "spiegel.de").url, record(1, "spiegel.de").url]);
});

test("the next run resumes from the cursor and merges without duplicates", async () => {
  const files = { [stampAgo(30)]: [record(1, "spiegel.de", "de")] };
  const { requested, deps } = feed(files);
  const env = makeEnv();
  await handleScheduled(env, new FakeContext(), deps);

  files[stampAgo(-2)] = [record(1, "spiegel.de", "de"), record(2, "spiegel.de", "de")];
  requested.length = 0;
  const later = { ...deps, now: () => NOW + 10 * MINUTE };
  await handleScheduled(env, new FakeContext(), later);

  assert.equal(requested[0], stampAgo(3));
  const countries = await env.NEWS_KV.get(FEED_KEYS.countries, "json");
  assert.equal(countries.countries.DE.length, 2);
});

test("an empty store is filled by the first request", async () => {
  const { deps } = feed({ [stampAgo(15)]: [record(1, "asahi.com", "ja")] });
  const env = makeEnv();
  const response = await call("/api/country/JP", env, deps);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 1);
  assert.ok(await env.NEWS_KV.get(FEED_KEYS.global, "json"));
});

test("repeat requests are served from cache, max_records and timespan only slice", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => record(i, "spiegel.de", "de", 5 + i));
  const { deps } = feed({ [stampAgo(10)]: lines });
  const env = makeEnv();
  await handleScheduled(env, new FakeContext(), deps);

  const first = await call("/api/global?max_records=5", env, deps);
  const second = await call("/api/global?max_records=25", env, deps);
  assert.match(first.headers.get("x-cache"), /^MISS/);
  assert.match(second.headers.get("x-cache"), /^HIT/);
  assert.equal((await first.json()).count, 5);
  assert.equal((await second.json()).count, 25);
  assert.equal((await (await call("/api/global?timespan=10min", env, deps)).json()).count, 5);
});

test("conditional requests get 304", async () => {
  const { deps } = feed({ [stampAgo(10)]: [record(1, "spiegel.de", "de")] });
  const env = makeEnv();
  const etag = (await call("/api/global", env, deps)).headers.get("etag");
  const response = await call("/api/global", env, deps, { headers: { "if-none-match": etag } });
  assert.equal(response.status, 304);
});

test("duplicate, junk and unsafe articles are dropped", async () => {
  const { deps } = feed({
    [stampAgo(10)]: [
      record(1, "spiegel.de", "de"),
      record(1, "spiegel.de", "de"),
      { ...record(2, "spiegel.de", "de"), title: record(1, "spiegel.de").title },
      { ...record(3, "spiegel.de", "de"), url: "javascript:alert(1)//2026-story-with-long-slug" },
      { ...record(4, "spiegel.de", "de"), url: "https://spiegel.de/tag/politik" },
      { ...record(5, "spiegel.de", "de"), img: "javascript:alert(1)" },
    ],
  });
  const body = await (await call("/api/global", makeEnv(), deps)).json();
  assert.deepEqual(
    body.articles.map((a) => a.url),
    [record(1, "spiegel.de").url, record(5, "spiegel.de").url],
  );
  assert.equal(body.articles[1].image, null);
});

test("feed outages surface as 502 when nothing is stored yet", async () => {
  const { deps } = feed({ [stampAgo(33)]: new Response("boom", { status: 500 }) });
  const response = await call("/api/global", makeEnv(), deps);
  assert.equal(response.status, 502);
  assert.match((await response.json()).detail, /HTTP 500/);
});

test("input validation", async () => {
  const { requested, deps } = feed({});
  const env = makeEnv();
  assert.equal((await call("/api/country/Atlantis", env, deps)).status, 400);
  assert.equal((await call("/api/country/%E0%A4%A", env, deps)).status, 400);
  assert.equal((await call("/api/global?max_records=0", env, deps)).status, 400);
  assert.equal((await call("/api/global?max_records=abc", env, deps)).status, 400);
  assert.equal((await call("/api/global?timespan=forever", env, deps)).status, 400);
  assert.equal((await call("/api/nope", env, deps)).status, 404);
  assert.equal((await call("/api/global", env, deps, { method: "POST" })).status, 405);
  assert.equal(requested.length, 0);
});

test("health and CORS preflight", async () => {
  const env = makeEnv();
  const health = await call("/api/health", env, {});
  assert.deepEqual(await health.json(), { status: "ok" });
  const preflight = await call("/api/global", env, {}, { method: "OPTIONS", headers: { origin: "https://x.example" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
});
