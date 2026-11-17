// MyAnimeZone community trending: { windowDays, mostSaved: [{ animeId }], mostSeen: [{ animeId }] }.
// animeId is an AniList ID. Returns [] on any failure so the warmer just skips this source.
export async function fetchCommunityTrendingIds(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
    if (!res?.ok) return [];
    const body = await res.json();
    const entries = [
      ...(Array.isArray(body?.mostSaved) ? body.mostSaved : []),
      ...(Array.isArray(body?.mostSeen) ? body.mostSeen : []),
    ];
    const ids = entries.map((e) => e?.animeId).filter((id) => Number.isInteger(id) && id > 0);
    return [...new Set(ids)];
  } catch {
    return [];
  }
}
