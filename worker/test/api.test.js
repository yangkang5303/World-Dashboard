import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/index.js";
import { FakeContext } from "./helpers.js";

const article = (n, country = "China") => ({
  url: `https://news.example/${n}`,
  title: `Headline ${n}`,
  seendate: "20261110T060000Z",
  domain: "news.example",
  language: "English",
  sourcecountry: country,
});

/** Fake GDELT: records queries and answers from a per-test script. */
function upstream(respond) {
  const queries = [];
  const fetchImpl = async (url) => {
    const query = new URL(url).searchParams.get("query");
    queries.push(query);
    const answer = await respond(query, queries.length);
    if (answer instanceof Response) return answer;
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer));
  };
  return { queries, deps: { fetchImpl, sleep: async () => {} } };
}

// Each test uses its own timespan so the module-level cache never overlaps.
let unique = 0;
const call = (path, deps, init) => {
  const ctx = new FakeContext();
  const request = new Request(`https://dash.example${path}`, init);
  return handleRequest(request, {}, ctx, deps).then(async (response) => {
    await ctx.settle();
    return response;
  });
};
const span = () => `${++unique}h`;

test("country requests query GDELT with the FIPS code for an ISO identifier", async () => {
  const { queries, deps } = upstream(() => ({ articles: [article(1), article(2)] }));
  const response = await call(`/api/country/CN?timespan=${span()}`, deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.match(queries[0], /^sourcecountry:CH AND \(/);
  assert.deepEqual(body.country, { iso2: "CN", name: "China" });
  assert.equal(body.count, 2);
  assert.deepEqual(body.articles[0].countries, [{ iso2: "CN", name: "China" }]);
});

test("Switzerland is not confused with China", async () => {
  const { queries, deps } = upstream(() => ({ articles: [article(1, "Switzerland")] }));
  const body = await (await call(`/api/country/CH?timespan=${span()}`, deps)).json();
  assert.match(queries[0], /^sourcecountry:SZ /);
  assert.equal(body.country.name, "Switzerland");
});

test("falls back to the plain country query when the themed one is empty or rejected", async () => {
  const empty = upstream((query) => (query.includes(" AND ") ? {} : { articles: [article(1, "Japan")] }));
  const body = await (await call(`/api/country/JP?timespan=${span()}`, empty.deps)).json();
  assert.deepEqual(empty.queries.length, 2);
  assert.equal(body.query, "sourcecountry:JA");
  assert.equal(body.count, 1);

  const rejected = upstream((query) => (query.includes(" AND ") ? "Your query was too common." : { articles: [] }));
  const response = await call(`/api/country/FR?timespan=${span()}`, rejected.deps);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).count, 0);
});

test("repeat requests are served from cache and max_records only slices", async () => {
  const { queries, deps } = upstream(() => ({ articles: Array.from({ length: 30 }, (_, i) => article(i)) }));
  const timespan = span();

  const first = await call(`/api/global?max_records=5&timespan=${timespan}`, deps);
  const second = await call(`/api/global?max_records=25&timespan=${timespan}`, deps);

  assert.equal(queries.length, 1);
  assert.match(first.headers.get("x-cache"), /^MISS/);
  assert.match(second.headers.get("x-cache"), /^HIT/);
  assert.equal((await first.json()).count, 5);
  assert.equal((await second.json()).count, 25);
});

test("conditional requests get 304", async () => {
  const { deps } = upstream(() => ({ articles: [article(1)] }));
  const path = `/api/global?timespan=${span()}`;
  const etag = (await call(path, deps)).headers.get("etag");
  const response = await call(path, deps, { headers: { "if-none-match": etag } });
  assert.equal(response.status, 304);
});

test("duplicate and unsafe articles are dropped", async () => {
  const { deps } = upstream(() => ({
    articles: [
      article(1),
      article(1),
      { ...article(2), title: "Headline 1" },
      { ...article(3), url: "javascript:alert(1)" },
      article(4, "Nowhereland"),
    ],
  }));
  const body = await (await call(`/api/global?timespan=${span()}`, deps)).json();
  assert.deepEqual(body.articles.map((a) => a.url), ["https://news.example/1", "https://news.example/4"]);
  assert.deepEqual(body.articles[1].countries, []);
});

test("rate limits are retried, then surfaced as 503", async () => {
  const recovering = upstream((_, n) => (n < 3 ? new Response("slow down", { status: 429 }) : { articles: [article(1)] }));
  const ok = await call(`/api/global?timespan=${span()}`, recovering.deps);
  assert.equal(ok.status, 200);
  assert.equal(recovering.queries.length, 3);

  const limited = upstream(() => "Please limit requests to one every 5 seconds.");
  const response = await call(`/api/global?timespan=${span()}`, limited.deps);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "10");
  assert.match((await response.json()).detail, /rate limit/);
});

test("input validation", async () => {
  const { queries, deps } = upstream(() => ({ articles: [] }));
  assert.equal((await call("/api/country/Atlantis", deps)).status, 400);
  assert.equal((await call("/api/country/%E0%A4%A", deps)).status, 400);
  assert.equal((await call("/api/global?max_records=0", deps)).status, 400);
  assert.equal((await call("/api/global?max_records=abc", deps)).status, 400);
  assert.equal((await call("/api/global?timespan=forever", deps)).status, 400);
  assert.equal((await call(`/api/global?query=${"x".repeat(500)}`, deps)).status, 400);
  assert.equal((await call("/api/nope", deps)).status, 404);
  assert.equal((await call("/api/global", deps, { method: "POST" })).status, 405);
  assert.equal(queries.length, 0);
});

test("health and CORS preflight", async () => {
  const health = await call("/api/health", {});
  assert.deepEqual(await health.json(), { status: "ok" });
  const preflight = await call("/api/global", {}, { method: "OPTIONS", headers: { origin: "https://x.example" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
});
