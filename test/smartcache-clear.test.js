import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disk tier in a temp dir, and a Redis URL nothing listens on, so this test can
// never wipe a developer's real cache or Redis.
const dir = mkdtempSync(join(tmpdir(), "smartcache-"));
process.env.CACHE_ENABLED = "true";
process.env.CACHE_DIR = dir;
process.env.REDIS_URL = "redis://127.0.0.1:1";
delete process.env.VERCEL;
const cache = await import("../core/smartcache.js");

test("clearAll empties memory and the disk tier", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    cache.set("map:1", { a: 1 }, 60_000);
    cache.set("epv:match2:kaa:1", { b: 1 }, 60_000);
  } finally {
    console.log = log;
  }
  writeFileSync(join(dir, "notes.txt"), "not a cache entry");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 2);

  const result = await cache.clearAll({ redisWaitMs: 200 });

  assert.equal(result.files, 2);
  assert.equal(result.redis, "unreachable");
  assert.equal(cache.get("map:1"), null);
  assert.equal(cache.get("epv:match2:kaa:1"), null);
  assert.deepEqual(readdirSync(dir), ["notes.txt"]);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
