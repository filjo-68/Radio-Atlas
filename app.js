import { countries, loadStations, catalogURL, normalizeSearch, countryMatches } from './data.js';
import { createPlayer } from './player.js';
import { createStats } from './stats.js';
import { languages, getLanguage, setLanguage, t, translatePage } from './i18n.js';

const $ = id => document.getElementById(id);
let num;
let collator;
let regionNames;
const countryByCode = new Map(countries.map(country => [country.code, country]));
const glyphs = {
  compass: '<circle cx="12" cy="12" r="9"/><path d="m15.8 8.2-2.2 5.4-5.4 2.2 2.2-5.4z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z"/>',
  heart: '<path d="M20.8 8.9c0 4.1-8.8 9.4-8.8 9.4S3.2 13 3.2 8.9a4.5 4.5 0 0 1 8.8-1.1 4.5 4.5 0 0 1 8.8 1.1Z"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  palette: '<path d="M20.8 11.6C20.8 6.9 16.8 3 12 3a9 9 0 0 0 0 18h1.1a2 2 0 0 0 1.4-3.4 1.4 1.4 0 0 1 1-2.4h1.9a3.4 3.4 0 0 0 3.4-3.6Z"/><path d="M7 11h.01M10 7h.01M15 7h.01M18 11h.01" stroke-width="2.8"/>',
  play: '<path d="M8 5v14l11-7z"/>',
  pause: '<path d="M9 5v14m6-14v14" stroke-width="2.7"/>',
  previous: '<path d="M5 5v14m13-14L8 12l10 7z"/>',
  next: '<path d="M19 5v14M6 5l10 7-10 7z"/>',
  language: '<path d="M3 5h11M8.5 3v2m3 0c-.6 4-3 7-7.5 9m2.5-5c1.1 1.8 2.8 3.2 5 4.2M12 20l4.5-10 4.5 10m-7.3-3.8h5.6"/>',
  search: '<circle cx="10.8" cy="10.8" r="5.8"/><path d="m15.2 15.2 4.3 4.3"/>',
  sort: '<path d="M8 5v14m-3-3 3 3 3-3m5 3V5m-3 3 3-3 3 3"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  radio: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="m5 8 11-5m-2 10h4m-4 3h4"/><circle cx="8.5" cy="14" r="2"/>',
  volume: '<path d="M4 9v6h4l4 4V5L8 9zm12 0a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10"/>',
  mute: '<path d="M4 9v6h4l4 4V5L8 9zm12 0 5 6m0-6-5 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  loading: '<path d="M21 12a9 9 0 1 1-9-9"/>'
};

function item(tag, className, label) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function setIcon(container, type) {
  if (container.dataset.renderedIcon === type) return;
  container.dataset.icon = type;
  container.dataset.renderedIcon = type;
  container.setAttribute('aria-hidden', 'true');
  container.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${glyphs[type]}</svg>`;
}

function icon(type) {
  const node = item('span');
  setIcon(node, type);
  return node;
}

for (const node of document.querySelectorAll('[data-icon]')) setIcon(node, node.dataset.icon);

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Private browsing may prevent persistence. */ }
}

const favoriteKey = 'radio-atlas:favorites';
const savedFavorites = read(favoriteKey, []);
const favorites = new Map((Array.isArray(savedFavorites) ? savedFavorites : [])
  .filter(station => station?.id && station?.name)
  .map(station => [station.id, station]));
const legacyCountries = countries.filter(({ code }) => {
  const ids = read(`radioFavorites_${code}`, []);
  return Array.isArray(ids) && ids.length;
});
let favoritesMigrating = Boolean(legacyCountries.length && !read('radio-atlas:migrated', false));
let view = 'discover';
let selectedCode = 'BG';
let stations = [];
let filtered = [];
let playlist = [];
let pending = false;
let loadError = false;
let loadVersion = 0;
const pageSize = 16;
let limit = pageSize;
let countriesLive = null;
let stationLive = null;


const audio = $('audio');
const player = createPlayer(audio, {
  onChange: state => updatePlayer(state),
  onNext: () => step(1),
  onPrevious: () => step(-1)
});

const stats = createStats({
  onCountries(data) {
    countriesLive = data?.countries ?? null;
    $('country-sort').querySelector('[value="listeners"]').disabled = !countriesLive;
    if (!countriesLive && $('country-sort').value === 'listeners') $('country-sort').value = 'featured';
    renderCountries();
  },
  onStations(code, data, heartbeat) {
    if (code !== selectedCode) return;
    if (heartbeat && !data?.stations && stationLive && data) {
      stationLive = { ...stationLive, ...data, stations: stationLive.stations };
    } else {
      stationLive = data?.stations ? data : null;
    }
    $('station-sort').querySelector('[value="listeners"]').disabled = !stationLive;
    if (!stationLive && $('station-sort').value === 'listeners') $('station-sort').value = 'popular';
    renderStations();
  }
});

if (stats) {
  for (const id of ['station-sort', 'country-sort']) {
    const option = item('option');
    option.dataset.i18n = 'byListeners';
    option.value = 'listeners';
    option.disabled = true;
    $(id).append(option);
  }
  stats.countries(countries.map(({ code }) => code));
  setInterval(() => {
    const state = player.state;
    stats.playback(state.station, state.status === 'playing', true);
    stats.countries(countries.map(({ code }) => code));
    refreshStationStats();
  }, 30000);
}

async function refreshStationStats() {
  if (!stats || pending || loadError || view === 'favorites') return;
  await stats.stations(selectedCode, stations);
}

function placeArt(container, station) {
  const key = station?.logo ?? '';
  if (container.dataset.logo === key) return;
  container.dataset.logo = key;
  container.replaceChildren(icon('radio'));
  if (!key) return;
  let url;
  try { url = new URL(key); } catch { return; }
  if (url.protocol !== 'https:' && (url.protocol !== 'http:' || location.protocol === 'https:')) return;
  const image = item('img');
  image.alt = '';
  image.loading = 'lazy';
  image.className = 'art-loading';
  image.addEventListener('load', () => image.classList.remove('art-loading'), { once: true });
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', () => image.remove(), { once: true });
  image.src = url.href;
  container.append(image);
}

function setFavoriteButton(button, station) {
  const active = Boolean(station && favorites.has(station.id));
  const label = t(active ? 'removeFavorite' : 'addFavorite');
  button.disabled = !station;
  button.setAttribute('aria-pressed', active);
  button.setAttribute('aria-label', station ? `${label} · ${station.name}` : label);
  button.title = label;
}

function toggleFavorite(station, button) {
  if (!station) return;
  if (favorites.has(station.id)) favorites.delete(station.id);
  else favorites.set(station.id, station);
  save(favoriteKey, [...favorites.values()]);
  setFavoriteButton($('player-favorite'), player.state.station ?? player.state.lastStation);
  if (view === 'favorites') {
    renderStations();
    if (button && document.activeElement === document.body) {
      const nextRow = $('station-list').querySelector('.favorite');
      (nextRow ?? $('station-search')).focus();
    }
  } else if (button) {
    setFavoriteButton(button, station);
  } else {
    for (const row of $('station-list').children) {
      if (row.dataset.stationId === station.id) setFavoriteButton(row.querySelector('.favorite'), station);
    }
  }
}

function countryLabel(code) {
  if (!countryByCode.has(code)) return code ?? '';
  return regionNames?.of(code) ?? (getLanguage() === 'bg' ? countryByCode.get(code).name : countryByCode.get(code).originalName);
}

function basicMeta(station) {
  return [countryLabel(station.country), station.codec, station.bitrate ? `${station.bitrate} kbps` : ''].filter(Boolean).join(' · ');
}

function renderStations() {
  const list = $('station-list');
  const isFavorites = view === 'favorites';
  const source = isFavorites ? [...favorites.values()] : stations;
  const query = normalizeSearch($('station-search').value);
  const current = player.state.station?.id;
  const value = $('station-sort').value;
  const shown = isFavorites || !pending;
  const live = !isFavorites && stationLive?.stations;
  $('station-sort').querySelector('[value="listeners"]')?.toggleAttribute('disabled', !live);
  filtered = shown ? source.filter(station => !query || normalizeSearch(
    [station.name, station.tags, countryLabel(station.country), station.country].flat().filter(Boolean).join(' ')
  ).includes(query)) : [];
  if (value === 'name') {
    filtered.sort((a, b) => collator.compare(a.name, b.name));
  } else if (value === 'listeners' && live) {
    filtered.sort((a, b) => Number(live[b.id] ?? 0) - Number(live[a.id] ?? 0) || b.votes - a.votes);
  } else {
    filtered.sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom)) || (b.votes ?? 0) - (a.votes ?? 0));
  }
  list.replaceChildren();
  list.setAttribute('aria-busy', String(!shown || (isFavorites && favoritesMigrating)));
  const count = $('station-count');
  const more = $('show-more');
  const liveTotal = $('live-total');
  liveTotal.hidden = isFavorites || !stationLive;
  if (!liveTotal.hidden) {
    liveTotal.textContent = t('liveTotal', { country: num.format(stationLive.country_listeners ?? 0), total: num.format(stationLive.listeners ?? 0) });
  }
  more.hidden = filtered.length <= limit;
  count.textContent = filtered.length
    ? t('visibleStations', { visible: num.format(Math.min(limit, filtered.length)), total: num.format(filtered.length) })
    : '';
  if (!filtered.length) {
    const message = !shown || (isFavorites && favoritesMigrating) ? t('loadingStations')
      : loadError && !isFavorites ? t('catalogUnavailable')
      : query ? t('noStationMatches')
      : isFavorites ? t('favoritesEmpty') : t('noStations');
    list.append(item('p', 'empty-state', message));
    if (loadError && !isFavorites) {
      const retry = item('button', 'quiet', t('retry'));
      retry.type = 'button';
      retry.addEventListener('click', () => chooseCountry(selectedCode));
      list.append(retry);
    }
  }
  for (const station of filtered.slice(0, limit)) {
    const row = item('div', 'station-row');
    row.dataset.stationId = station.id;
    row.classList.toggle('is-current', station.id === current);
    const start = item('button', 'station-main');
    start.type = 'button';
    start.setAttribute('aria-label', t('playNamed', { name: station.name }));
    const art = item('span', 'station-art');
    placeArt(art, station);
    const copy = item('span', 'station-copy');
    const detail = live
      ? [basicMeta(station), t('stationListeners', { count: num.format(live[station.id] ?? 0) })].filter(Boolean).join(' · ')
      : basicMeta(station);
    copy.append(item('strong', '', station.name), item('small', '', detail));
    const indicator = item('span', 'row-play');
    indicator.append(icon('play'));
    start.append(art, copy, indicator);
    start.addEventListener('click', () => {
      playlist = filtered.slice();
      const current = player.state;
      if (current.station?.id === station.id && ['playing', 'loading'].includes(current.status)) player.pause();
      else player.play(station);
    });
    const favorite = item('button', 'icon-button favorite');
    favorite.type = 'button';
    favorite.append(icon('heart'));
    setFavoriteButton(favorite, station);
    favorite.addEventListener('click', () => toggleFavorite(station, favorite));
    row.append(start, favorite);
    list.append(row);
  }
  markCurrent(player.state);
}

function renderCountries() {
  const list = $('country-list');
  const query = $('country-search').value;
  const all = view === 'countries';
  const type = $('country-sort').value;
  const matches = countries.filter(country => countryMatches(country, query, countryLabel(country.code)));
  if (type === 'name' && all) matches.sort((a, b) => collator.compare(countryLabel(a.code), countryLabel(b.code)));
  if (type === 'stations' && all) matches.sort((a, b) => b.count - a.count || collator.compare(countryLabel(a.code), countryLabel(b.code)));
  if (type === 'listeners' && all && countriesLive) {
    matches.sort((a, b) => Number(countriesLive[b.code] ?? 0) - Number(countriesLive[a.code] ?? 0));
  }
  list.replaceChildren();
  list.classList.toggle('is-full', all);
  if (!matches.length) list.append(item('p', 'empty-state', t('noCountryMatches')));
  for (const country of all ? matches : matches.slice(0, query.trim() ? 12 : 6)) {
    const button = item('button', 'country-item');
    button.type = 'button';
    button.setAttribute('aria-pressed', country.code === selectedCode && view !== 'favorites');
    const flag = item('img', 'country-flag');
    flag.alt = '';
    flag.width = 27;
    flag.height = 20;
    flag.src = country.flag;
    flag.loading = 'lazy';
    const amount = countriesLive ? countriesLive[country.code] ?? 0 : country.count;
    const count = item('small', '', num.format(amount));
    count.setAttribute('aria-label', t(countriesLive ? 'listeningCount' : 'stationCount', { count: num.format(amount) }));
    count.title = countriesLive ? t('liveListeners') : t('stationsInCatalog');
    button.append(flag, item('span', '', countryLabel(country.code)), count);
    button.addEventListener('click', () => {
      navigate('stations', country.code);
      focusSection('stations');
    });
    list.append(button);
  }
}

function markCurrent(state) {
  const { station, status } = state;
  for (const row of $('station-list').children) {
    if (!row.dataset.stationId) continue;
    const current = row.dataset.stationId === station?.id;
    const playing = current && status === 'playing';
    const loading = current && status === 'loading';
    row.classList.toggle('is-current', current);
    row.querySelector('.station-main').setAttribute('aria-label',
      t(playing || loading ? 'pauseNamed' : 'playNamed', { name: row.querySelector('strong').textContent }));
    setIcon(row.querySelector('.row-play [data-icon]'), loading ? 'loading' : playing ? 'pause' : 'play');
  }
}

function updatePlayer(state) {
  const { station, lastStation, status, error, volume, muted, volumeSupported } = state;
  const track = station ?? lastStation;
  $('track-name').textContent = track?.name ?? t('noStation');
  $('track-name').title = track?.name ?? '';
  const statusKeys = { loading: 'connecting', playing: 'live', paused: 'paused', error: 'streamProblem' };
  const trackMeta = track
    ? [statusKeys[status] && t(statusKeys[status]), error ? t(error) : basicMeta(track)].filter(Boolean).join(' · ')
    : t('pickStation');
  if ($('track-meta').textContent !== trackMeta) $('track-meta').textContent = trackMeta;
  $('track-meta').title = trackMeta;
  placeArt($('player-cover'), track);
  setFavoriteButton($('player-favorite'), track);
  const active = status === 'playing' || status === 'loading';
  $('play').disabled = !track;
  $('play').setAttribute('aria-label', active ? t('pause') : status === 'error' ? t('retry') : t('play'));
  setIcon($('play').firstElementChild, status === 'loading' ? 'loading' : active ? 'pause' : 'play');
  $('previous').disabled = !track;
  $('next').disabled = !track;
  for (const slider of [$('volume'), $('mobile-range')]) slider.value = Math.round(volume * 100);
  $('volume-panel').hidden = volumeSupported === false;
  $('volume-mobile').hidden = volumeSupported === false;
  for (const button of [$('mute'), $('mobile-mute')]) {
    button.setAttribute('aria-label', muted ? t('unmute') : t('mute'));
    setIcon(button.firstElementChild, muted || volume === 0 ? 'mute' : 'volume');
  }
  $('resume').hidden = !lastStation;
  $('resume-label').textContent = lastStation ? t('lastNamed', { name: lastStation.name }) : t('lastStation');
  markCurrent(state);
  stats?.playback(station, status === 'playing');
}

async function step(direction) {
  const track = player.state.station ?? player.state.lastStation;
  if (!track) return;
  let choices = playlist;
  if (!choices.some(station => station.id === track.id)) {
    choices = filtered.some(station => station.id === track.id) ? filtered : [];
    if (!choices.length) {
      try { choices = await loadStations(track.country); } catch { return; }
      const selected = player.state.station ?? player.state.lastStation;
      if (selected?.id !== track.id) return;
    }
  }
  if (choices.length < 2) return;
  const index = choices.findIndex(station => station.id === track.id);
  if (index < 0) return;
  playlist = choices;
  player.play(choices[(index + direction + choices.length) % choices.length]);
}

function refreshSavedStations(records) {
  let favoritesChanged = false;
  const { lastStation, station: selected } = player.state;
  for (const station of records) {
    const favorite = favorites.get(station.id);
    if (favorite && JSON.stringify(favorite) !== JSON.stringify(station)) {
      favorites.set(station.id, station);
      favoritesChanged = true;
    }
    if (station.id === lastStation?.id || station.id === selected?.id) player.refreshStation(station);
  }
  if (favoritesChanged) {
    save(favoriteKey, [...favorites.values()]);
    if (view === 'favorites') renderStations();
  }
}

async function refreshSavedCountry(code) {
  if (!countryByCode.has(code)) return;
  try {
    refreshSavedStations(await loadStations(code));
  } catch {
    // Keep using the locally saved station details when the catalog is unavailable.
  }
}

async function refreshFavoriteCountries() {
  const codes = new Set([...favorites.values()].map(station => station.country));
  for (const code of codes) await refreshSavedCountry(code);
}

async function chooseCountry(code) {
  if (!countryByCode.has(code)) return;
  selectedCode = code;
  const version = ++loadVersion;
  stationLive = null;
  if ($('station-sort').value === 'listeners') $('station-sort').value = 'popular';
  $('station-country').textContent = countryLabel(selectedCode);
  pending = true;
  loadError = false;
  stations = [];
  renderStations();
  try {
    const result = await loadStations(selectedCode);
    if (version !== loadVersion) return;
    stations = result;
    refreshSavedStations(stations);
  } catch {
    if (version !== loadVersion) return;
    loadError = true;
  }
  pending = false;
  renderStations();
  refreshStationStats();
}

function display(next, code = selectedCode) {
  const codeChanged = code !== selectedCode;
  view = next;
  const isDiscover = view === 'discover';
  const isCountries = view === 'countries';
  const isFavorites = view === 'favorites';
  $('hero').hidden = !isDiscover;
  $('stations').hidden = isCountries;
  $('countries').hidden = isFavorites || view === 'stations';
  $('country-tools').hidden = !isCountries;
  $('all-countries').hidden = isCountries;
  $('choose-country').hidden = isFavorites;
  translateView();
  document.querySelectorAll('[data-view]').forEach(button => {
    if (button.dataset.view === view || (view === 'stations' && button.dataset.view === 'countries')) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  limit = pageSize;
  if (codeChanged) $('station-search').value = '';
  if (codeChanged || (!stations.length && !pending && !isFavorites && !isCountries)) chooseCountry(code);
  else renderStations();
  renderCountries();
  if (isFavorites) void refreshFavoriteCountries();
}

function route() {
  const url = new URL(location.href);
  const code = (url.searchParams.get('country') ?? '').toUpperCase();
  const saved = read('radio-atlas:country', 'BG');
  const fallback = countryByCode.has(saved) ? saved : 'BG';
  const next = url.searchParams.get('view');
  if (next === 'countries' || next === 'favorites') return [next, countryByCode.has(code) ? code : fallback];
  return countryByCode.has(code) ? ['stations', code] : ['discover', fallback];
}

function navigate(next, code = selectedCode) {
  const url = new URL(location.href);
  if (next === 'stations') url.searchParams.set('country', code);
  else url.searchParams.delete('country');
  if (next === 'favorites' || next === 'countries') url.searchParams.set('view', next);
  else url.searchParams.delete('view');
  url.hash = '';
  if (url.href !== location.href) history.pushState(null, '', url);
  if (next === 'stations') save('radio-atlas:country', code);
  $('station-search').value = '';
  display(next, code);
}

function focusSection(id) {
  const section = $(id);
  section.focus({ preventScroll: true });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  section.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}

function openCountries() {
  navigate('countries');
  focusSection('countries');
  $('country-search').focus({ preventScroll: true });
}

function translateView() {
  const isFavorites = view === 'favorites';
  $('breadcrumb').textContent = t(view);
  $('stations-title').textContent = t(isFavorites ? 'favoriteStations' : 'stations');
  $('station-subtitle').textContent = t(isFavorites ? 'personalCatalog' : 'selectStation');
  $('station-country').textContent = countryLabel(selectedCode);
  $('install-status').textContent = t('installHTTPS');
}

function applyLanguage() {
  const language = getLanguage();
  num = new Intl.NumberFormat(language);
  collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true });
  regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(language, { type: 'region', fallback: 'none' }) : null;
  translatePage({ count: num.format(countries.length) });
  $('language-code').textContent = language === 'zh-Hans' ? '中文' : language.toUpperCase();
  for (const button of $('language-options').children) {
    button.setAttribute('aria-pressed', String(button.dataset.language === language));
  }
  translateView();
  updatePlayer(player.state);
  player.refreshMetadata();
}

$('language-button').addEventListener('click', () => {
  $('language-dialog').showModal();
  $('language-options').querySelector('[aria-pressed="true"]')?.focus();
});
for (const [code, label] of languages) {
  const button = item('button', '', label);
  button.type = 'button';
  button.dataset.language = code;
  button.lang = code;
  button.addEventListener('click', () => {
    if (setLanguage(code)) {
      applyLanguage();
      renderStations();
      renderCountries();
    }
    $('language-dialog').close();
  });
  $('language-options').append(button);
}

const themes = { day: '#f3f5ef', night: '#111915', dusk: '#f6eff5', contrast: '#000000' };
function applyTheme(theme) {
  if (!Object.hasOwn(themes, theme)) theme = 'day';
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content = themes[theme];
  document.querySelectorAll('[data-theme-choice]').forEach(button => {
    button.setAttribute('aria-pressed', button.dataset.themeChoice === theme);
  });
}

applyTheme(read('radio-atlas:theme', matchMedia('(prefers-contrast: more)').matches ? 'contrast' : matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day'));
$('theme-button').addEventListener('click', () => $('theme-dialog').showModal());
document.querySelectorAll('[data-theme-choice]').forEach(button => {
  button.addEventListener('click', () => {
    applyTheme(button.dataset.themeChoice);
    save('radio-atlas:theme', button.dataset.themeChoice);
    $('theme-dialog').close();
  });
});

let installPrompt;
function standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone; }
function updateInstall() {
  for (const button of document.querySelectorAll('[data-install]')) button.hidden = Boolean(standalone());
}
window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  updateInstall();
});
updateInstall();
for (const button of document.querySelectorAll('[data-install]')) {
  button.addEventListener('click', async () => {
    if (installPrompt) {
      const prompt = installPrompt;
      installPrompt = null;
      try { await prompt.prompt(); return; } catch { /* Show manual steps. */ }
    }
    $('install-status').hidden = window.isSecureContext;
    $('install-status').textContent = t('installHTTPS');
    $('install-dialog').showModal();
  });
}

window.addEventListener('popstate', () => display(...route()));
document.querySelector('.skip-link').addEventListener('click', event => {
  event.preventDefault();
  if (view === 'countries') navigate('stations');
  focusSection('stations');
});
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    navigate(button.dataset.view);
    if (view === 'discover') window.scrollTo(0, 0);
    else focusSection(view === 'countries' ? 'countries' : 'stations');
  });
}
$('choose-country').addEventListener('click', openCountries);
$('all-countries').addEventListener('click', openCountries);
$('hero-browse').addEventListener('click', () => focusSection('stations'));
$('resume').addEventListener('click', () => {
  const { lastStation, station, status } = player.state;
  if (!lastStation) return;
  if (lastStation.id !== station?.id || status !== 'playing') player.play(lastStation);
});
$('play').addEventListener('click', () => player.toggle());
$('previous').addEventListener('click', () => step(-1));
$('next').addEventListener('click', () => step(1));
for (const slider of [$('volume'), $('mobile-range')]) {
  slider.addEventListener('input', event => player.setVolume(Number(event.target.value) / 100));
}
for (const button of [$('mute'), $('mobile-mute')]) button.addEventListener('click', () => player.toggleMute());
$('volume-mobile').addEventListener('click', () => $('volume-dialog').showModal());
$('player-favorite').addEventListener('click', () => toggleFavorite(player.state.station ?? player.state.lastStation));
for (const id of ['station-search', 'station-sort']) $(id).addEventListener('input', () => {
  limit = pageSize;
  renderStations();
});
$('country-search').addEventListener('input', renderCountries);
$('country-sort').addEventListener('change', renderCountries);
$('show-more').addEventListener('click', () => {
  const nextIndex = limit;
  limit += pageSize;
  renderStations();
  $('station-list').children[nextIndex]?.querySelector('button')?.focus();
});

if (favoritesMigrating) {
  Promise.allSettled(legacyCountries.map(async ({ code }) => {
    const ids = new Set(read(`radioFavorites_${code}`, []));
    for (const station of await loadStations(code)) {
      if (ids.has(station.id) && !favorites.has(station.id)) favorites.set(station.id, station);
    }
  })).then(results => {
    favoritesMigrating = false;
    save(favoriteKey, [...favorites.values()]);
    if (results.every(result => result.status === 'fulfilled')) save('radio-atlas:migrated', true);
    renderStations();
    setFavoriteButton($('player-favorite'), player.state.station ?? player.state.lastStation);
  });
}

applyLanguage();
display(...route());
void refreshSavedCountry(player.state.lastStation?.country);

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const country = countryByCode.get(selectedCode);
    for (const url of [catalogURL(selectedCode), country.flag]) fetch(url).catch(() => {});
  }, { once: true });
  navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Offline cache unavailable:', error));
}
