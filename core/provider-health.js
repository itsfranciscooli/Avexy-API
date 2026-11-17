// In-memory record of how each provider's site has been answering this process,
// for GET /status. Only real upstream calls are recorded (cache hits are not),
// so the warmup keeps it fresh. Resets on restart.

export const PROVIDERS = [
  "mkissa", "reanime", "anikoto", "animegg", "animenosub", "anizone", "aniwaves",
  "senshi", "kaa", "animedunya", "animeonsen", "anipm", "gogoanime", "animesaturn",
];

const WINDOW          = 20;  // recent outcomes kept per provider
const NO_MATCH_MIN    = 5;   // "no matches" needs at least this many misses with no success
const MAX_ERROR_CHARS = 200;

// Outcome kinds:
//   ok          upstream answered with data
//   noMatch     upstream answered but the show wasn't found (or a 404/4xx for that show)
//   blocked     401/403 from the site
//   rateLimited 429 from the site
//   error       5xx or a network failure
const FAILURE_KINDS = new Set(["blocked", "rateLimited", "error"]);
const STATUS_LABEL  = {
  ok: "ok", blocked: "blocked", rateLimited: "rate limited", error: "error",
  noMatches: "no matches", unknown: "not checked yet",
};

const health = new Map();

function entryFor(name) {
  let entry = health.get(name);
  if (!entry) {
    entry = {
      recent: [], status: "unknown", httpStatus: null, since: null,
      lastCheckedAt: null, lastOkAt: null, lastError: null,
    };
    health.set(name, entry);
  }
  return entry;
}

const ID_LABEL_BEFORE = /(?:AniList|MAL|ep|source|ID)\s$/i;

// Providers report HTTP failures inconsistently: err.status, "HTTP 403 ...",
// "Senshi episodes 403 (MAL 1)", "Fetch 403: url", "Embed fetch failed: 403".
export function httpStatusOf(error) {
  const status = Number(error?.status);
  if (status >= 400 && status <= 599) return status;

  const message = String(error?.message ?? "");
  const http = message.match(/\bHTTP\s+([45]\d\d)\b/i) ?? message.match(/failed:\s*([45]\d\d)\b/i);
  if (http) return Number(http[1]);

  const bare = message.match(/^([^:(]*?)\b([45]\d\d)(?=\s*(?:[:(]|$))/);
  if (bare && !ID_LABEL_BEFORE.test(bare[1])) return Number(bare[2]);
  return null;
}

const NETWORK_ERROR = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|connection (?:reset|error|refused)|socket hang up|timed? ?out|aborted/i;
// AniList is shared by every provider; its outages say nothing about one provider.
const ANILIST_ERROR = /No data found for AniList|AniList HTTP/i;

// Returns { kind, httpStatus } or null when the failure shouldn't count at all.
export function classifyFailure(error) {
  const message = String(error?.message ?? error ?? "");
  if (ANILIST_ERROR.test(message)) return null;

  const httpStatus = httpStatusOf(error);
  if (httpStatus === 401 || httpStatus === 403) return { kind: "blocked", httpStatus };
  if (httpStatus === 429) return { kind: "rateLimited", httpStatus };
  if (httpStatus >= 500) return { kind: "error", httpStatus };
  if (httpStatus) return { kind: "noMatch", httpStatus };
  if (NETWORK_ERROR.test(message)) return { kind: "error", httpStatus: null };
  return { kind: "noMatch", httpStatus: null };
}

function deriveStatus(recent) {
  for (let i = recent.length - 1; i >= 0; i--) {
    const outcome = recent[i];
    if (outcome.kind === "ok") return { status: "ok", httpStatus: null };
    if (FAILURE_KINDS.has(outcome.kind)) return { status: outcome.kind, httpStatus: outcome.httpStatus };
  }
  if (recent.length >= NO_MATCH_MIN) return { status: "noMatches", httpStatus: null };
  return { status: "unknown", httpStatus: null };
}

function record(name, kind, httpStatus, message) {
  const entry = entryFor(name);
  const now   = new Date().toISOString();

  entry.recent.push({ kind, httpStatus });
  if (entry.recent.length > WINDOW) entry.recent.shift();
  entry.lastCheckedAt = now;
  if (kind === "ok") {
    entry.lastOkAt  = now;
    entry.lastError = null;
  } else if (message) {
    entry.lastError = message.replace(/\s+/g, " ").slice(0, MAX_ERROR_CHARS);
  }

  const next = deriveStatus(entry.recent);
  if (next.status !== entry.status || next.httpStatus !== entry.httpStatus) {
    entry.status     = next.status;
    entry.httpStatus = next.httpStatus;
    entry.since      = now;
  }
}

export function recordProviderSuccess(name) {
  record(name, "ok", null, null);
}

export function recordProviderFailure(name, error) {
  const outcome = classifyFailure(error);
  if (!outcome) return;
  record(name, outcome.kind, outcome.httpStatus, String(error?.message ?? error ?? ""));
}

// Wraps a provider call so every real upstream attempt is recorded; errors rethrow.
export function trackProvider(name, fn) {
  return async (...args) => {
    try {
      const result = await fn(...args);
      recordProviderSuccess(name);
      return result;
    } catch (error) {
      recordProviderFailure(name, error);
      throw error;
    }
  };
}

function summarize(entry) {
  const label = STATUS_LABEL[entry.status];
  if (entry.status === "unknown") return label;
  const code = entry.httpStatus ? ` (${entry.httpStatus})` : "";
  return `${label}${code} since ${entry.since.replace(/\.\d{3}Z$/, "Z")}`;
}

export function providerHealth() {
  const sources = {};
  const summary = {};
  for (const name of PROVIDERS) {
    const entry  = entryFor(name);
    const counts = {};
    for (const { kind } of entry.recent) counts[kind] = (counts[kind] ?? 0) + 1;
    const label  = STATUS_LABEL[entry.status];
    summary[label] = (summary[label] ?? 0) + 1;
    sources[name] = {
      status:        label,
      httpStatus:    entry.httpStatus,
      summary:       summarize(entry),
      since:         entry.since,
      lastCheckedAt: entry.lastCheckedAt,
      lastOkAt:      entry.lastOkAt,
      lastError:     entry.lastError,
      recent:        counts,
    };
  }
  return { summary, sources };
}

export function resetProviderHealth() {
  health.clear();
}
