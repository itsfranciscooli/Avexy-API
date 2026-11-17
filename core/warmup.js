// Cache warmer: proactively builds the /episodes/:id cache for popular anime.
//   hourly     — MyAnimeZone community trending, AniList trending, shows airing today
//   six-hourly — AniList all-time popular, current season, airing this week
// Started from server.js only (Node). Each job warms its whole set every run; the episode
// cache itself decides whether a cached show actually needs re-scraping.
import { fetchTopAnimeIds, fetchSeasonAnimeIds, fetchAiringSchedule } from "./anilist.js";
import { fetchCommunityTrendingIds } from "./community-trending.js";
import { warmEpisodes } from "./episode-cache.js";

const HOUR = 3_600_000;
const DAY_SEC = 86_400;
const DEFAULT_COMMUNITY_URL = "https://myanimezone.xyz/api/community/trending";

function envBool(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["true", "1", "yes", "on"].includes(String(raw).toLowerCase());
}

function envInt(env, name, fallback) {
  const n = Number(env[name]);
  return env[name] !== undefined && env[name] !== "" && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function readConfig(env) {
  return {
    enabled: envBool(env, "WARMUP_ENABLED", true),
    limit: envInt(env, "WARMUP_LIMIT", 50),
    concurrency: envInt(env, "WARMUP_CONCURRENCY", 3),
    communityUrl: env.WARMUP_COMMUNITY_URL ?? DEFAULT_COMMUNITY_URL,
    // Minimum gap between starting two shows. Each show costs a few AniList calls, so this keeps
    // the warmer well under AniList's ~90 requests/minute limit, leaving room for real users.
    spacingMs: 1000,
  };
}

export function currentSeason(date) {
  const month = date.getUTCMonth();
  const season = month < 3 ? "WINTER" : month < 6 ? "SPRING" : month < 9 ? "SUMMER" : "FALL";
  return { season, year: date.getUTCFullYear() };
}

export function mergeIds(lists) {
  return [...new Set(lists.flat())];
}

export async function runWithConcurrency(items, n, fn, spacingMs = 0) {
  const stats = { ok: 0, failed: 0 };
  let next = 0;
  let nextStartAt = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      const wait = nextStartAt - Date.now();
      nextStartAt = Math.max(Date.now(), nextStartAt) + spacingMs;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try { await fn(item); stats.ok++; }
      catch { stats.failed++; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return stats;
}

const safe = (promise) => Promise.resolve().then(() => promise).catch(() => []);
const scheduleIds = (schedule) => schedule.map((s) => s.mediaId);

export async function collectHourlyIds(cfg, nowMs, src) {
  const nowSec = Math.floor(nowMs / 1000);
  const [community, trending, airing] = await Promise.all([
    cfg.communityUrl ? safe(src.community(cfg.communityUrl)) : [],
    safe(src.top("TRENDING_DESC", cfg.limit)),
    safe(src.airing(nowSec - 6 * 3600, nowSec + DAY_SEC)),
  ]);
  return mergeIds([community, trending, scheduleIds(airing)]);
}

export async function collectSixHourlyIds(cfg, nowMs, src, excludeIds) {
  const nowSec = Math.floor(nowMs / 1000);
  const { season, year } = currentSeason(new Date(nowMs));
  // Sequential on purpose: keeps AniList request bursts small (rate limit ~90/min).
  const popular = await safe(src.top("POPULARITY_DESC", cfg.limit));
  const seasonal = await safe(src.season(season, year));
  const week = await safe(src.airing(nowSec, nowSec + 7 * DAY_SEC));
  return mergeIds([popular, seasonal, scheduleIds(week)]).filter((id) => !excludeIds.has(id));
}

// run() resolves to the collected ids, or null when skipped because the previous run is still going.
export function createJob(name, collect, warm, cfg, log) {
  let running = false;
  return {
    async run() {
      if (running) return null;
      running = true;
      const started = Date.now();
      try {
        const ids = await collect().catch((e) => { log(`[warmup:${name}] collect failed: ${e.message}`); return []; });
        const { ok, failed } = await runWithConcurrency(ids, cfg.concurrency, warm, cfg.spacingMs);
        log(`[warmup:${name}] ${ids.length} shows, ${ok} warmed, ${failed} failed in ${Math.round((Date.now() - started) / 1000)}s`);
        return ids;
      } finally {
        running = false;
      }
    },
  };
}

// One hourly timer. The hourly job runs every tick; the six-hourly job runs on the first tick and
// every 6th one after, always once the hourly run has finished so it can skip what that run covered.
export function createSchedule(runHourly, runSixHourly, timers = globalThis) {
  let ticks = 0;
  let handle = null;
  const tick = async () => {
    const n = ticks++;
    await runHourly().catch(() => {});
    if (n % 6 === 0) await runSixHourly().catch(() => {});
  };
  return {
    start() {
      handle = timers.setInterval(tick, HOUR);
      handle?.unref?.();
      return tick();
    },
    stop() { timers.clearInterval(handle); },
  };
}

export function startWarmup(env = process.env) {
  const cfg = readConfig(env);
  if (!cfg.enabled || !envBool(env, "CACHE_ENABLED", false)) return null;

  const src = {
    top: fetchTopAnimeIds,
    season: fetchSeasonAnimeIds,
    airing: fetchAiringSchedule,
    community: fetchCommunityTrendingIds,
  };
  const log = (msg) => console.log(msg);
  const warm = (id) => warmEpisodes(id).catch((e) => {
    console.error(`[warmup] ${id}: ${e.message}`);
    throw e;
  });

  let hourlySet = new Set();
  const hourly = createJob("hourly", () => collectHourlyIds(cfg, Date.now(), src), warm, cfg, log);
  const sixHourly = createJob("six-hourly", () => collectSixHourlyIds(cfg, Date.now(), src, hourlySet), warm, cfg, log);

  const runHourly = () => hourly.run().then((ids) => { if (ids) hourlySet = new Set(ids); });
  const runSixHourly = () => sixHourly.run();

  const schedule = createSchedule(runHourly, runSixHourly);
  schedule.start();
  log(`[warmup] started (limit ${cfg.limit}, concurrency ${cfg.concurrency}, community ${cfg.communityUrl ? "on" : "off"})`);

  return { stop: schedule.stop };
}
