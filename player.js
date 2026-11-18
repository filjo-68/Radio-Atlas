import { t, getLanguage } from './i18n.js';

const LAST_STATION = "radioAtlas:lastStation";
const VOLUME = "radioAtlas:volume";
const MUTED = "radioAtlas:muted";
const CONNECTION_TIMEOUT = 15000;
const APP_ARTWORK = new URL("./icons/icon-512.png", import.meta.url).href;

function readPreference(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function savePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep playing when storage is disabled.
  }
}

function volumeValue(value, fallback = 0.75) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function networkUrl(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function cleanStation(input) {
  if (!input || typeof input.id !== "string" || typeof input.name !== "string") return null;
  const id = input.id.trim();
  const name = input.name.trim();
  const sources = Array.isArray(input.streams) ? input.streams : [];
  const streams = [...new Set(
    [input.stream, ...sources, input.url_resolved, input.url]
      .map(value => networkUrl(value)?.href)
      .filter(Boolean)
  )];
  if (!id || !name || !streams.length) return null;
  return {
    id,
    name,
    stream: streams[0],
    streams,
    logo: networkUrl(input.logo)?.href || "",
    country: typeof input.country === "string" ? input.country : "",
    codec: typeof input.codec === "string" ? input.codec : "",
    bitrate: Number(input.bitrate) || 0,
    votes: Number(input.votes) || 0,
    tags: typeof input.tags === "string" ? input.tags : "",
    homepage: networkUrl(input.homepage)?.href || "",
    custom: Boolean(input.custom),
    hls: Boolean(input.hls)
  };
}

function savedStation() {
  try {
    return cleanStation(JSON.parse(readPreference(LAST_STATION)));
  } catch {
    return null;
  }
}

function connectionUrls(station) {
  if (location.protocol !== "https:") return station.streams;
  const urls = station.streams.map(value => new URL(value));
  const secure = urls.filter(url => url.protocol === "https:");
  for (const url of urls) {
    if (url.protocol !== "http:" || !url.hostname.includes(".") ||
        /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) continue;
    url.protocol = "https:";
    secure.push(url);
  }
  return [...new Set(secure.map(url => url.href))];
}

function playbackError(error, usedHttpSource) {
  if (error?.name === "NotAllowedError") return "allowAudio";
  if (navigator.onLine === false) return "offlineAudio";
  if (usedHttpSource) return "secureStreamUnavailable";
  if (error?.name === "TimeoutError") return "streamTimeout";
  return "streamUnavailable";
}

export function createPlayer(audio, { onChange, onNext, onPrevious, artwork = APP_ARTWORK } = {}) {
  let lastStation = savedStation();
  let station = lastStation;
  let status = station ? "paused" : "idle";
  let error = "";
  let active = null;
  let hls = null;
  const mediaSession = navigator.mediaSession;

  const legacyVolume = volumeValue(Number(readPreference("radioVolume") ?? 75) / 100);
  let volume = volumeValue(readPreference(VOLUME), legacyVolume);
  let muted = readPreference(MUTED) === "true";
  let volumeSupported = false;
  try {
    audio.volume = 0.42;
    volumeSupported = Math.abs(audio.volume - 0.42) < 0.01;
    if (volumeSupported) audio.volume = volume;
  } catch {
    // Some mobile browsers use their device volume controls.
  }
  audio.muted = muted;

  function snapshot() {
    return { station, lastStation, status, error, volume, muted, volumeSupported };
  }

  function emit() {
    onChange?.(snapshot());
  }

  function setStatus(next, message = "") {
    if (status === next && error === message) return;
    status = next;
    error = message;
    if (mediaSession) {
      mediaSession.playbackState = next === "playing" || (next === "loading" && active?.attempt?.started)
        ? "playing" : station ? "paused" : "none";
    }
    emit();
  }

  function setMetadata() {
    if (!mediaSession || !station || typeof MediaMetadata !== "function") return;
    const images = [{ src: new URL(artwork, location.href).href, sizes: "512x512", type: "image/png" }];
    const logo = networkUrl(station.logo);
    if (logo?.protocol === "https:") images.unshift({ src: logo.href });
    mediaSession.metadata = new MediaMetadata({
      title: station.name,
      artist: t('appName'),
      album: /^[A-Z]{2}$/.test(station.country) && typeof Intl.DisplayNames === 'function'
        ? new Intl.DisplayNames(getLanguage(), { type: 'region' }).of(station.country)
        : station.country || t('liveRadio'),
      artwork: images
    });
  }

  function releaseMedia() {
    const previousHls = hls;
    hls = null;
    previousHls?.destroy();
    audio.pause();
    if (!audio.hasAttribute("src")) return;
    audio.removeAttribute("src");
    audio.load();
  }

  function stopActive() {
    const old = active;
    active = null;
    old?.attempt?.cancel();
    releaseMedia();
  }

  async function attachAndPlay(run, attempt, url) {
    const isHls = /\.m3u8(?:[?#]|$)/i.test(url) ||
      ((run.station.hls || run.station.codec.toUpperCase() === "HLS") &&
        !/\.(?:mp3|aac|mp4|ogg|opus)(?:[?#]|$)/i.test(url));
    if (isHls && !audio.canPlayType("application/vnd.apple.mpegurl")) {
      const { default: Hls } = await import("./vendor/hls.light.min.mjs");
      if (active !== run || run.attempt !== attempt || attempt.cancelled) return;
      if (!Hls.isSupported()) throw new DOMException("HLS unavailable", "NotSupportedError");
      hls = new Hls({ enableWorker: false });
      hls.on(Hls.Events.ERROR, (_event, details) => {
        if (details.fatal && active === run && run.attempt === attempt) handleStreamError();
      });
      hls.loadSource(url);
      hls.attachMedia(audio);
    } else {
      audio.src = url;
      audio.load();
    }
    await audio.play();
  }

  function startAttempt(run, url) {
    return new Promise((resolve, reject) => {
      const attempt = {
        cancelled: false,
        started: false,
        stallTimer: null,
        cancel() {
          attempt.cancelled = true;
          clearTimeout(timeout);
          clearTimeout(attempt.stallTimer);
          reject(new DOMException("Playback cancelled", "AbortError"));
        },
        fail(cause) {
          clearTimeout(timeout);
          reject(cause);
        }
      };
      run.attempt = attempt;
      const timeout = setTimeout(() => {
        attempt.cancelled = true;
        attempt.fail(new DOMException("Playback timed out", "TimeoutError"));
      }, CONNECTION_TIMEOUT);
      attachAndPlay(run, attempt, url).then(() => {
        clearTimeout(timeout);
        resolve();
      }, attempt.fail);
    });
  }

  async function connect(run, failure = null) {
    while (active === run && run.next < run.urls.length) {
      const url = run.urls[run.next++];
      setStatus("loading");
      try {
        await startAttempt(run, url);
        if (active !== run) return false;
        run.attempt.started = true;
        lastStation = run.station;
        savePreference(LAST_STATION, JSON.stringify(lastStation));
        setStatus("playing");
        return true;
      } catch (cause) {
        if (active !== run) return false;
        failure = cause;
        run.attempt.cancelled = true;
        run.attempt = null;
        releaseMedia();
        if (cause?.name === "NotAllowedError") break;
      }
    }
    if (active !== run) return false;
    stopActive();
    const needsHttps = location.protocol === "https:" &&
      run.station.streams.every(url => url.startsWith("http:"));
    setStatus("error", playbackError(failure, needsHttps));
    return false;
  }

  function play(input) {
    if (!input) return Promise.resolve(false);
    const selected = cleanStation(input);
    stopActive();
    if (!selected) {
      setStatus("error", "invalidStream");
      return Promise.resolve(false);
    }
    station = selected;
    setMetadata();
    const run = { station, urls: connectionUrls(station), next: 0, attempt: null };
    active = run;
    if (status === "loading") emit();
    else setStatus("loading");
    return connect(run);
  }

  function pause() {
    stopActive();
    setStatus(station ? "paused" : "idle");
  }

  function toggle() {
    if (status === "playing" || status === "loading") return pause();
    return play(station || lastStation);
  }

  function refreshStation(input) {
    const refreshLast = lastStation?.id === input.id;
    const refreshSelected = station?.id === input.id && status !== "playing" && status !== "loading";
    if (!refreshLast && !refreshSelected) return;
    const updated = cleanStation(input);
    if (!updated) return;

    if (refreshLast) {
      lastStation = updated;
      savePreference(LAST_STATION, JSON.stringify(updated));
    }
    if (refreshSelected) {
      station = updated;
      setMetadata();
    }
    emit();
  }

  function setMuted(value) {
    const next = Boolean(value);
    if (muted === next) return;
    muted = next;
    audio.muted = muted;
    savePreference(MUTED, muted);
    emit();
  }

  function setVolume(value) {
    if (!volumeSupported) return;
    const next = volumeValue(value, volume);
    if (volume === next) return;
    volume = next;
    audio.volume = volume;
    if (volume > 0 && muted) {
      muted = false;
      audio.muted = false;
      savePreference(MUTED, false);
    }
    savePreference(VOLUME, volume);
    emit();
  }

  function handleStreamError(cause = new Error("Stream interrupted")) {
    const run = active;
    const attempt = run?.attempt;
    if (!attempt || attempt.cancelled) return;
    if (!attempt.started) {
      attempt.fail(cause);
      return;
    }
    attempt.cancelled = true;
    clearTimeout(attempt.stallTimer);
    run.attempt = null;
    releaseMedia();
    void connect(run, cause);
  }

  audio.addEventListener("waiting", () => {
    const attempt = active?.attempt;
    if (!attempt?.started || audio.paused) return;
    setStatus("loading");
    attempt.stallTimer ??= setTimeout(() => {
      if (active?.attempt === attempt) {
        handleStreamError(new DOMException("Playback stalled", "TimeoutError"));
      }
    }, CONNECTION_TIMEOUT);
  });
  audio.addEventListener("playing", () => {
    const attempt = active?.attempt;
    if (!attempt?.started || audio.paused) return;
    clearTimeout(attempt.stallTimer);
    attempt.stallTimer = null;
    setStatus("playing");
  });
  audio.addEventListener("pause", () => {
    if (active?.attempt?.started && audio.paused && !audio.ended && !audio.error) pause();
  });
  audio.addEventListener("error", () => {
    if (audio.error) handleStreamError();
  });
  audio.addEventListener("ended", () => {
    if (audio.ended) handleStreamError();
  });
  audio.addEventListener("volumechange", () => {
    const nextVolume = volumeSupported ? audio.volume : volume;
    const nextMuted = audio.muted;
    if (volume === nextVolume && muted === nextMuted) return;
    volume = nextVolume;
    muted = nextMuted;
    savePreference(VOLUME, volume);
    savePreference(MUTED, muted);
    emit();
  });

  if (mediaSession) {
    const actions = {
      play: () => {
        if (status !== "playing" && status !== "loading") void play(station || lastStation);
      },
      pause,
      stop: pause,
      nexttrack: onNext,
      previoustrack: onPrevious
    };
    for (const [action, handler] of Object.entries(actions)) {
      try {
        mediaSession.setActionHandler(action, handler || null);
      } catch {
        // Platform action availability varies.
      }
    }
  }

  return {
    get state() { return snapshot(); },
    play,
    pause,
    toggle,
    setVolume,
    refreshMetadata: setMetadata,
    refreshStation,
    setMuted,
    toggleMute: () => setMuted(!muted)
  };
}
