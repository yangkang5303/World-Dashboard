import test from "node:test";
import assert from "node:assert/strict";
import { SwrCache } from "../src/cache.js";
import { FakeContext, FakeEdgeCache } from "./helpers.js";

const policy = { ttlMs: 1_000, staleMs: 10_000, errorTtlMs: 500 };

function setup() {
  const clock = { t: 1_000_000 };
  const edge = new FakeEdgeCache();
  const make = () => new SwrCache({ now: () => clock.t, edge: () => edge });
  return { clock, edge, make, cache: make(), ctx: new FakeContext() };
}

test("miss, then hit without calling the loader again", async () => {
  const { cache, ctx } = setup();
  let calls = 0;
  const loader = async () => ({ n: ++calls });

  const first = await cache.get("k", policy, loader, ctx);
  const second = await cache.get("k", policy, loader, ctx);

  assert.equal(first.state, "MISS");
  assert.equal(second.state, "HIT");
  assert.deepEqual(second.value, { n: 1 });
  assert.equal(calls, 1);
});

test("concurrent misses share a single upstream call", async () => {
  const { cache, ctx } = setup();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true };
  };

  const results = await Promise.all(Array.from({ length: 25 }, () => cache.get("k", policy, loader, ctx)));

  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.value.ok));
});

test("stale entries are served immediately and refreshed in the background", async () => {
  const { cache, ctx, clock } = setup();
  let version = 0;
  const loader = async () => ({ version: ++version });

  await cache.get("k", policy, loader, ctx);
  clock.t += 2_000;

  const stale = await cache.get("k", policy, loader, ctx);
  assert.equal(stale.state, "STALE");
  assert.equal(stale.value.version, 1);

  await ctx.settle();
  const fresh = await cache.get("k", policy, loader, ctx);
  assert.equal(fresh.state, "HIT");
  assert.equal(fresh.value.version, 2);
});

test("a failing upstream keeps serving stale data and is not hammered", async () => {
  const { cache, ctx, clock } = setup();
  let calls = 0;
  let broken = false;
  const loader = async () => {
    calls += 1;
    if (broken) throw new Error("upstream down");
    return { calls };
  };

  await cache.get("k", policy, loader, ctx);
  broken = true;
  clock.t += 2_000;

  assert.equal((await cache.get("k", policy, loader, ctx)).state, "STALE");
  await ctx.settle();
  assert.equal(calls, 2);

  // Inside the negative-cache window: no further upstream attempts.
  const again = await cache.get("k", policy, loader, ctx);
  await ctx.settle();
  assert.equal(again.state, "STALE-ERROR");
  assert.equal(again.value.calls, 1);
  assert.equal(calls, 2);
});

test("errors propagate when nothing is cached, and are briefly remembered", async () => {
  const { cache, ctx, clock } = setup();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    throw new Error("boom");
  };

  await assert.rejects(cache.get("k", policy, loader, ctx), /boom/);
  await assert.rejects(cache.get("k", policy, loader, ctx), /boom/);
  assert.equal(calls, 1);

  clock.t += 600;
  await assert.rejects(cache.get("k", policy, loader, ctx), /boom/);
  assert.equal(calls, 2);
});

test("a new isolate is warmed from the edge cache", async () => {
  const { cache, make, ctx } = setup();
  await cache.get("k", policy, async () => ({ from: "origin" }), ctx);
  await ctx.settle();

  const result = await make().get("k", policy, async () => assert.fail("loader must not run"), ctx);
  assert.equal(result.state, "HIT");
  assert.equal(result.tier, "edge");
  assert.deepEqual(result.value, { from: "origin" });
});

test("entries past the stale window are reloaded", async () => {
  const { cache, ctx, clock } = setup();
  let version = 0;
  const loader = async () => ({ version: ++version });
  await cache.get("k", policy, loader, ctx);
  clock.t += 20_000;
  const result = await cache.get("k", policy, loader, ctx);
  assert.equal(result.state, "MISS");
  assert.equal(result.value.version, 2);
});
