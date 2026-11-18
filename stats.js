const setting = document.querySelector('meta[name="radio-stats-api"]')?.content.trim();
const statsURL = (() => {
  if (!setting || !window.isSecureContext) return null;
  try {
    const url = new URL(setting, location.href);
    return url.origin === location.origin ? url : null;
  } catch {
    return null;
  }
})();

async function post(action, body, country) {
  const url = new URL(statsURL);
  url.searchParams.set('action', action);
  if (country) url.searchParams.set('country', country);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined
  });
  if (!response.ok) throw new Error('Statistics unavailable');
  return response.json();
}

export function createStats({ onCountries, onStations }) {
  if (!statsURL) return null;
  let sessionID, previous, heartbeatSequence = 0, stationSequence = 0;
  let heartbeatQueue = Promise.resolve();

  return {
    async countries(codes) {
      try {
        const data = await post('countries', { countries: codes });
        onCountries(data);
      } catch { onCountries(null); }
    },
    async stations(country, stations) {
      const sequence = ++stationSequence;
      try {
        const data = await post('stations', { station_ids: stations.map(station => station.id) }, country);
        if (sequence === stationSequence) onStations(country, data);
      } catch {
        if (sequence === stationSequence) onStations(country, null);
      }
    },
    async playback(station, listening, periodic = false) {
      const next = listening && station ? { country: station.country, station_id: station.id } : null;
      if (!next && !previous || !periodic && next && previous && next.station_id === previous.station_id) return;
      const payload = next ?? previous;
      previous = next;
      sessionID ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
      const sequence = ++heartbeatSequence;
      heartbeatQueue = heartbeatQueue.then(async () => {
        try {
          const data = await post('heartbeat', { session_id: sessionID, ...payload, listening: Boolean(next) });
          if (sequence === heartbeatSequence) onStations(payload.country, data, true);
        } catch { /* The local catalog and audio can still be used. */ }
      });
    }
  };
}
