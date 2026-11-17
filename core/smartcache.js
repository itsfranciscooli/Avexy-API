// Reads process.env safely — process may be undefined/limited on edge runtimes.
function readEnv(name) {
  try {
    return typeof process !== "undefined" ? process.env?.[name] : undefined;
  } catch { return undefined; }
}

function envBool(name, fallback) {
  const raw = readEnv(name);
  if (raw === undefined || raw === "") return fallback;
  return ["true", "1", "yes", "on"].includes(String(raw).toLowerCase());
}

function envInt(name, fallback) {
  const raw = readEnv(name);
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}

// change CACHE_ENABLED=true in .env to enable caching (memory + disk + local Redis)
export const _CACHE_ENABLED = envBool("CACHE_ENABLED", false);

const IS_LOCAL_NODE = (() => {
  try {
    return (
      typeof process !== "undefined" &&
      typeof process.versions?.node === "string" &&
      !process.env.VERCEL
    );
  } catch { return false; }
})();

// REDIS_URL points at a local Redis server (see docker-compose.yml). No external
// service is required: if Redis isn't reachable, the cache transparently falls back
// to the in-memory + on-disk tiers below.
const REDIS_URL = readEnv("REDIS_URL") ?? "redis://127.0.0.1:6379";

// DEFAULT_REDIS_TTL is in seconds (default 900s / 15min) — used as the fallback expiry
// for Redis writes that don't carry their own computed ttl (see redisWrite below).
const REDIS_TTL_MS = envInt("DEFAULT_REDIS_TTL", 900) * 1000;

function encodeEntry(entry) {
  return JSON.stringify(entry, (_, value) => value === Infinity ? "__Infinity__" : value);
}

function decodeEntry(raw) {
  return JSON.parse(raw, (_, value) => value === "__Infinity__" ? Infinity : value);
}

// Local Redis client (Node only — TCP sockets don't exist on edge runtimes, where
// the cache stays memory-only). redisReady tracks the live connection so commands
// fail fast to the memory/disk fallback whenever Redis is down or unreachable.
let redisClient = null;
let redisReady  = false;

if (IS_LOCAL_NODE && _CACHE_ENABLED) {
  try {
    const { default: Redis } = await import("ioredis");
    redisClient = new Redis(REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 2000)),
    });
    redisClient.on("ready", () => { redisReady = true; });
    redisClient.on("close", () => { redisReady = false; });
    redisClient.on("error", () => {}); // swallow: avoids crashing on an unhandled 'error' event
  } catch {
    redisClient = null;
  }
}

async function redisCommand(command) {
  if (!redisReady || !redisClient) return null;
  try {
    return await redisClient.call(...command);
  } catch {
    return null;
  }
}

async function redisWrite(key, entry) {
  if (!redisReady) return;
  const value = encodeEntry(entry);
  const ttlMs = Number.isFinite(entry.ttl) && entry.ttl > 0 ? entry.ttl : REDIS_TTL_MS;
  await redisCommand(["SET", key, value, "PX", Math.ceil(ttlMs)]);
}

// Resolves true once Redis is connected, false if it errors or doesn't come up
// within timeoutMs (no Redis configured, or unreachable).
function waitForRedis(timeoutMs) {
  if (!redisClient) return Promise.resolve(false);
  if (redisReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (ok) => {
      clearTimeout(timer);
      redisClient.off("ready", onReady);
      redisClient.off("error", onError);
      resolve(ok);
    };
    const onReady = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    redisClient.once("ready", onReady);
    redisClient.once("error", onError);
  });
}

let diskRead  = () => null;
let diskWrite = () => {};
let diskDel   = () => {};
let diskClear = () => 0;
let diskCount = () => null;

if (IS_LOCAL_NODE) {
  const { readFileSync, mkdirSync, existsSync, readdirSync, rmSync } = await import("node:fs");
  const { writeFile, unlink }                   = await import("node:fs/promises");
  const { join, dirname }                        = await import("node:path");
  const { fileURLToPath }                        = await import("node:url");

  const __dir    = dirname(fileURLToPath(import.meta.url));
  const CACHE_DIR = readEnv("CACHE_DIR") || join(__dir, ".cache");
  try { mkdirSync(CACHE_DIR, { recursive: true }); } catch {}

  diskClear = () => {
    let removed = 0;
    try {
      for (const name of readdirSync(CACHE_DIR)) {
        if (!name.endsWith(".json")) continue;
        try { rmSync(join(CACHE_DIR, name), { force: true }); removed++; } catch {}
      }
    } catch {}
    return removed;
  };

  diskCount = () => {
    try { return readdirSync(CACHE_DIR).filter((name) => name.endsWith(".json")).length; }
    catch { return null; }
  };

  const keyToPath = (key) =>
    join(CACHE_DIR, key.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json");

  diskRead = (key) => {
    try {
      const p = keyToPath(key);
      if (!existsSync(p)) return null;
      return decodeEntry(readFileSync(p, "utf8"));
    } catch { return null; }
  };

  diskWrite = (key, entry) => {
    writeFile(keyToPath(key), encodeEntry(entry)).catch(() => {});
  };

  diskDel = (key) => {
    unlink(keyToPath(key)).catch(() => {});
  };
}

const MAX_MEM = 800;
const mem     = new Map();

function evict() {
  if (mem.size <= MAX_MEM) return;
  const drop = mem.size - MAX_MEM;
  let   n    = 0;
  for (const k of mem.keys()) {
    if (n++ >= drop) break;
    mem.delete(k);
  }
}

export function get(key) {
  if (!_CACHE_ENABLED) return null;
  let e = mem.get(key);
  if (e) return e;

  e = diskRead(key);
  if (!e) return null;

  mem.set(key, e);
  evict();
  return e;
}

export async function getAsync(key) {
  if (!_CACHE_ENABLED) return null;
  let e = get(key);
  if (e) return e;

  const raw = await redisCommand(["GET", key]);
  if (!raw) return null;

  try {
    e = typeof raw === "string" ? decodeEntry(raw) : raw;
    if (!isFresh(e)) {
      await delAsync(key);
      return null;
    }
    mem.set(key, e);
    evict();
    diskWrite(key, e);
    return e;
  } catch {
    return null;
  }
}

function formatTtl(ms) {
  if (!Number.isFinite(ms)) return "forever";
  if (ms >= 86_400_000) return `${Math.round(ms / 86_400_000)}d`;
  if (ms >= 3_600_000)  return `${Math.round(ms / 3_600_000)}h`;
  if (ms >= 60_000)     return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

// One line per cached result. sync:* keys are internal refresh bookkeeping, not results.
function logStored(key, ttlMs) {
  if (key.startsWith("sync:")) return;
  console.log(`[cache] stored ${key} (ttl ${formatTtl(ttlMs)})`);
}

function setLocal(key, data, ttlMs, refreshAfterMs) {
  const now   = Date.now();
  const entry = {
    data,
    cachedAt:     now,
    ttl:          ttlMs,
    refreshAfter: refreshAfterMs ?? ttlMs,
    expiresAt:    now + ttlMs,
  };
  mem.delete(key);
  mem.set(key, entry);
  evict();
  diskWrite(key, entry);
  logStored(key, ttlMs);
  return entry;
}

export function set(key, data, ttlMs, refreshAfterMs) {
  if (!_CACHE_ENABLED) return { data, cachedAt: Date.now(), ttl: ttlMs, refreshAfter: refreshAfterMs ?? ttlMs, expiresAt: Date.now() + ttlMs };
  const entry = setLocal(key, data, ttlMs, refreshAfterMs);
  redisWrite(key, entry).catch(() => {});
  return entry;
}

export async function setAsync(key, data, ttlMs, refreshAfterMs) {
  if (!_CACHE_ENABLED) return { data, cachedAt: Date.now(), ttl: ttlMs, refreshAfter: refreshAfterMs ?? ttlMs, expiresAt: Date.now() + ttlMs };
  const entry = setLocal(key, data, ttlMs, refreshAfterMs);
  await redisWrite(key, entry);
  return entry;
}

export function isFresh(entry) {
  return entry !== null && entry !== undefined && Date.now() < entry.expiresAt;
}

export function needsRefresh(entry) {
  return !entry || Date.now() - entry.cachedAt > entry.refreshAfter;
}

function delLocal(key) {
  mem.delete(key);
  diskDel(key);
}

export function del(key) {
  delLocal(key);
  redisCommand(["DEL", key]).catch(() => {});
}

export async function delAsync(key) {
  delLocal(key);
  await redisCommand(["DEL", key]);
}

export function delByPrefix(prefix) {
  for (const k of [...mem.keys()]) {
    if (k.startsWith(prefix)) mem.delete(k);
  }
}

export async function delByPrefixAsync(prefix) {
  delByPrefix(prefix);
  const keys = await redisCommand(["KEYS", `${prefix}*`]);
  if (Array.isArray(keys) && keys.length) {
    await redisCommand(["DEL", ...keys]);
  }
}

// Wipes every tier: memory, the on-disk .cache files and the Redis database at
// REDIS_URL (FLUSHDB). server.js calls this on startup so each restart begins
// with an empty cache. FLUSHDB clears the whole Redis database, so REDIS_URL
// should point at a Redis (or db index) used only by this API.
export async function clearAll({ redisWaitMs = 5000 } = {}) {
  mem.clear();
  const files = diskClear();
  let redis = "not configured";
  if (redisClient) {
    redis = await waitForRedis(redisWaitMs)
      ? ((await redisCommand(["FLUSHDB"])) === "OK" ? "flushed" : "flush failed")
      : "unreachable";
  }
  return { memory: true, files, redis };
}

// Snapshot of every tier for GET /status. Redis is pinged live; REDIS_URL itself
// is never reported since it can carry a password.
// redis.status: "connected" | "disconnected" | "disabled" (CACHE_ENABLED=false)
//               | "unavailable" (edge runtime or ioredis missing)
export async function cacheStatus() {
  const redis = { status: "disabled" };
  if (_CACHE_ENABLED) {
    if (!redisClient) {
      redis.status = "unavailable";
    } else if (!redisReady) {
      redis.status = "disconnected";
    } else {
      const started = Date.now();
      const pong = await redisCommand(["PING"]);
      if (pong === "PONG") {
        redis.status = "connected";
        redis.latencyMs = Date.now() - started;
        redis.keys = await redisCommand(["DBSIZE"]);
      } else {
        redis.status = "disconnected";
      }
    }
  }

  return {
    enabled: _CACHE_ENABLED,
    memory:  { entries: mem.size, max: MAX_MEM },
    disk:    { enabled: IS_LOCAL_NODE, entries: diskCount() },
    redis,
  };
}

const MIN  = 60_000;
const HOUR = 60 * MIN;
const DAY  = 24 * HOUR;

export function episodeTTL(status) {
  switch (status) {
    case "FINISHED":         return [7 * DAY,   Infinity];
    case "RELEASING":        return [2 * HOUR,  15 * MIN];
    case "HIATUS":           return [6 * HOUR,  60 * MIN];
    case "NOT_YET_RELEASED": return [30 * MIN,  15 * MIN];
    default:                 return [HOUR,       15 * MIN];
  }
}

export function mapTTL(status) {
  return status === "FINISHED" ? 30 * DAY : 12 * HOUR;
}

export const WATCH_TTL         = 3 * HOUR;
export const SHOW_IDENTITY_TTL = 24 * HOUR;
export const THIRTY_DAYS       = 30 * DAY;
