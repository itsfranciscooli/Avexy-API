import { test } from "node:test";
import assert from "node:assert/strict";

// Memory-only cache for this test: VERCEL makes smartcache skip the disk and Redis tiers.
process.env.CACHE_ENABLED = "true";
process.env.VERCEL = "1";
const cache = await import("../core/smartcache.js");

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try { await fn(); } finally { console.log = original; }
  return lines;
}

test("logs every cached result with its key and ttl", async () => {
  const lines = await captureLogs(async () => {
    cache.set("episodes:match3:1", { a: 1 }, 30 * 86_400_000);
    await cache.setAsync("map:2", { b: 1 }, 2 * 3_600_000);
    await cache.setAsync("watch:x:3", { c: 1 }, 30 * 60_000);
  });
  assert.deepEqual(lines, [
    "[cache] stored episodes:match3:1 (ttl 30d)",
    "[cache] stored map:2 (ttl 2h)",
    "[cache] stored watch:x:3 (ttl 30m)",
  ]);
});

test("does not log internal sync bookkeeping", async () => {
  const lines = await captureLogs(() => { cache.set("sync:1", { lastProbeAt: 1 }, 60_000); });
  assert.deepEqual(lines, []);
});
