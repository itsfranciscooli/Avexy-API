// Cache warmer: keeps the /episodes/:id cache filled for popular anime, using exactly the same
// rules as the API itself (see core/episode-cache.js):
//   - each episode list is stored for 30 days;
//   - a show is re-checked against AniList/ani.zip 15 min after its last check, or every 5 min
//     from 10 min before an episode airs until 6 h after;
//   - it is re-scraped only when something changed or it is still airing.
// The show lists it tracks follow the same pattern: each is cached for 30 days and re-fetched
// every 15 min (MyAnimeZone community trending, AniList trending, shows airing today and this
// week, the current season, AniList all-time popular).
// Started from server.js only (Node).
import { fetchTopAnimeIds, fetchSeasonAnimeIds, fetchAiringSchedule } from "./anilist.js";
import { fetchCommunityTrendingIds } from "./community-trending.js";
import { warmEpisodes, isRefreshDue } from "./episode-cache.js";
import { get, set, needsRefresh } from "./smartcache.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAY_SEC = 86_400;
const LIST_TTL = 30 * DAY;
const LIST_REFRESH = 15 * MIN;
const TICK = MIN;
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

// The tracked show lists, in priority order (earlier lists are warmed first on each tick).
// "airing" covers [now - 6 h, now + 7 d]: shows airing today plus the rest of the week.
export function listFetchers(cfg, src) {
  const fetchers = {};
  if (cfg.communityUrl) fetchers.community = () => src.community(cfg.communityUrl);
  fetchers.trending = () => src.top("TRENDING_DESC", cfg.limit);
  fetchers.airing = async (nowMs) => {
    const nowSec = Math.floor(nowMs / 1000);
    const schedule = await src.airing(nowSec - 6 * 3600, nowSec + 7 * DAY_SEC);
    return schedule.map((s) => s.mediaId);
  };
  fetchers.season = (nowMs) => {
    const { season, year } = currentSeason(new Date(nowMs));
    return src.season(season, year);
  };
  fetchers.popular = () => src.top("POPULARITY_DESC", cfg.limit);
  return fetchers;
}

// Last failed fetch per list, per cache, so a failing source is retried every 15 min, not every tick.
const failures = new WeakMap();

// Returns the merged tracked ids. Each list is cached for 30 days and re-fetched once it is older
// than 15 minutes. A failed or empty fetch keeps the cached list. Fetched one at a time on purpose:
// keeps AniList request bursts small (rate limit ~90/min).
export async function refreshLists(fetchers, nowMs, cache) {
  if (!failures.has(cache)) failures.set(cache, new Map());
  const failedAt = failures.get(cache);
  const lists = [];

  for (const [name, fetchList] of Object.entries(fetchers)) {
    const key = `warmup:list:${name}`;
    let entry = cache.get(key);
    const backingOff = entry && nowMs - (failedAt.get(name) ?? -Infinity) < LIST_REFRESH;

    if (cache.needsRefresh(entry) && !backingOff) {
      const ids = await Promise.resolve().then(() => fetchList(nowMs)).catch(() => []);
      if (Array.isArray(ids) && ids.length) {
        cache.set(key, ids, LIST_TTL, LIST_REFRESH);
        failedAt.delete(name);
        entry = cache.get(key);
      } else {
        failedAt.set(name, nowMs);
      }
    }
    lists.push(entry?.data ?? []);
  }
  return mergeIds(lists);
}

// tick(): collect the tracked ids, then warm the ones whose probe is due. A tick that starts while
// the previous one is still running is skipped. Never throws.
export function createWarmer({ cfg, collect, isDue, warm, log }) {
  let running = false;
  return {
    async tick() {
      if (running) return;
      running = true;
      const started = Date.now();
      try {
        const ids = await collect();
        const due = ids.filter((id) => isDue(id));
        if (!due.length) return;
        const { ok, failed } = await runWithConcurrency(due, cfg.concurrency, warm, cfg.spacingMs);
        log(`[warmup] ${due.length} of ${ids.length} tracked shows due, ${ok} checked, ${failed} failed in ${Math.round((Date.now() - started) / 1000)}s`);
      } catch (e) {
        log(`[warmup] tick failed: ${e.message}`);
      } finally {
        running = false;
      }
    },
  };
}

// Runs fn now and then every minute. One minute is finer than the shortest probe interval (5 min),
// so each show is re-checked within a minute of becoming due.
export function createTicker(fn, timers = globalThis) {
  let handle = null;
  return {
    start() {
      handle = timers.setInterval(fn, TICK);
      handle?.unref?.();
      return fn();
    },
    stop() { timers.clearInterval(handle); },
  };
}

export function startWarmup(env = process.env) {
  const cfg = readConfig(env);
  if (!cfg.enabled || !envBool(env, "CACHE_ENABLED", false)) return null;

  const fetchers = listFetchers(cfg, {
    top: fetchTopAnimeIds,
    season: fetchSeasonAnimeIds,
    airing: fetchAiringSchedule,
    community: fetchCommunityTrendingIds,
  });
  const cache = { get, set, needsRefresh };
  const log = (msg) => console.log(msg);

  const warmer = createWarmer({
    cfg,
    collect: () => refreshLists(fetchers, Date.now(), cache),
    isDue: (id) => isRefreshDue(id),
    warm: (id) => warmEpisodes(id).catch((e) => {
      console.error(`[warmup] ${id}: ${e.message}`);
      throw e;
    }),
    log,
  });

  const ticker = createTicker(() => warmer.tick());
  ticker.start();
  log(`[warmup] started (lists: ${Object.keys(fetchers).join(", ")}; limit ${cfg.limit}, concurrency ${cfg.concurrency})`);

  return { stop: ticker.stop };
}
