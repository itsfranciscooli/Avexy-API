import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disk tier in a temp dir, and a Redis URL nothing listens on.
const dir = mkdtempSync(join(tmpdir(), "status-"));
process.env.CACHE_ENABLED = "true";
process.env.CACHE_DIR = dir;
process.env.REDIS_URL = "redis://127.0.0.1:1";
delete process.env.VERCEL;
const cache = await import("../core/smartcache.js");
const { default: worker } = await import("../index.js");
const { recordProviderFailure } = await import("../core/provider-health.js");

test("GET /status reports api and cache tiers", async () => {
  const log = console.log;
  console.log = () => {};
  try {
    cache.set("map:1", { a: 1 }, 60_000);
  } finally {
    console.log = log;
  }
  await new Promise((r) => setTimeout(r, 50));
  recordProviderFailure("animedunya", new Error("AnimeDunya HTTP 403 fetching https://anime-dunya.com/en/anime/1"));

  const res = await worker.fetch(new Request("http://localhost/status"), { API_VERSION: "test" });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "no-store");

  const body = await res.json();
  assert.equal(body.status, "degraded");
  assert.equal(body.api.status, "ok");
  assert.equal(body.api.version, "test");
  assert.equal(typeof body.api.uptimeSeconds, "number");
  assert.equal(body.cache.enabled, true);
  assert.equal(body.cache.memory.entries, 1);
  assert.equal(body.cache.disk.entries, 1);
  assert.equal(body.cache.redis.status, "disconnected");
  assert.equal(JSON.stringify(body).includes("redis://"), false);
  assert.equal(body.providers.sources.animedunya.status, "blocked");
  assert.match(body.providers.sources.animedunya.summary, /^blocked \(403\) since /);
  assert.equal(body.providers.sources.gogoanime.status, "not checked yet");
  assert.equal(Object.keys(body.providers.sources).length, 14);

  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
});
