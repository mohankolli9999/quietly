(() => {
  'use strict';

  // Per-site detection lives in one registry, so adding a site is a single
  // entry. Everything else in this file is site-agnostic: the engine below
  // never mentions Spotify or Amazon.
  const ADAPTERS = [
    {
      name: 'spotify',
      match: (h) => h.includes('spotify.com'),
      barSelector: '[data-testid="now-playing-bar"]',
      adAttribute: 'data-testadtype',
      // Spotify renders this unconditionally from its own isAd(state.item), so
      // a missing attribute means the markup changed under us — report stale.
      classify: (v) => (v === null ? 'stale' : v === 'ad-type-ad' ? 'ad' : 'clear')
    },
    {
      name: 'amazon',
      match: (h) => h.includes('music.amazon.'),
      barSelector: '#transport music-horizontal-item',
      adAttribute: 'primary-href',
      // Songs carry primary-href="#" (or none); ads carry a real click-through
      // URL. A song and a renamed attribute look identical here, so we never
      // report stale for Amazon — a lost node surfaces as "waiting" instead.
      classify: (v) => (v === null || v === '#' ? 'clear' : 'ad'),
      // Music always plays through MSE (a blob: src); an ad is a plain file, so
      // during a confirmed ad a non-blob media element is the ad. Seeking it to
      // its end makes the player fire its own completion and load the next
      // track — a true skip, no transport buttons, no server round-trip.
      block: {
        isAdMedia: (el) => {
          const s = el.currentSrc || el.src || '';
          return !!s && !s.startsWith('blob:');
        }
      }
    }
  ];

  // hostname is empty under file:// (the test harness), where __quietlySite
  // picks the adapter instead. In a real tab hostname always wins, so a page
  // script cannot use that global to steer us.
  const adapter = location.hostname
    ? ADAPTERS.find((a) => a.match(location.hostname))
    : ADAPTERS.find((a) => a.name === window.__quietlySite);
  if (!adapter) return;

  const STATE_EVENT = '__quietly_state';
  const CONFIG_EVENT = '__quietly_config';

  // No real ad runs this long. If the flag is still set we assume our own
  // reading is wrong and stop muting rather than leave the user in silence.
  const STUCK_MS = 180000;

  const SEARCH_MS = 30000;

  let enabled = true;
  let mode = 'mute';
  let adActive = false;
  let stuck = false;
  let health = 'ok';
  let bar = null;
  let barObserver = null;
  let searchObserver = null;
  let searchTimer = null;
  let stuckTimer = null;
  let lastPayload = '';

  // WeakRef so a long session does not retain every media element the player
  // discards. Dead refs are pruned as we iterate.
  const tracked = new Set();
  const priorMuted = new WeakMap();

  const eachMedia = (fn) => {
    for (const ref of tracked) {
      const el = ref.deref();
      if (el) fn(el);
      else tracked.delete(ref);
    }
  };

  const shouldMute = () => enabled && adActive && !stuck;

  // Skipping is opt-in per site and only for adapters that know how to. Muting
  // always runs first, so a site with skipping armed is muted too and falls
  // back to silence if the skip never lands.
  const canBlock = () => shouldMute() && mode === 'block' && !!adapter.block;

  const emit = () => {
    const payload = JSON.stringify({
      site: adapter.name,
      ad: adActive,
      muting: shouldMute(),
      blocking: canBlock(),
      health,
      enabled
    });
    if (payload === lastPayload) return;
    lastPayload = payload;
    document.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: payload }));
  };

  const reassert = () => {
    if (!shouldMute()) return;
    eachMedia((el) => {
      if (!el.muted) el.muted = true;
    });
    attemptSkip();
  };

  const muteElement = (el) => {
    if (!priorMuted.has(el)) priorMuted.set(el, el.muted);
    el.muted = true;
    // The player re-reads muted from its own cache on every load(), so a single
    // assignment at ad start is not enough.
    el.addEventListener('timeupdate', reassert, true);
  };

  const applyMute = () => eachMedia(muteElement);

  // Seeking an ad element to its end makes the player fire its own "track
  // finished" and advance, so the ad is skipped without touching any transport
  // control. Guard: never re-seek an element already at its end, or the seek
  // fires on every timeupdate; the guard also re-arms cleanly for the next ad.
  const attemptSkip = () => {
    if (!canBlock()) return;
    eachMedia((el) => {
      if (!adapter.block.isAdMedia(el)) return;
      if (!isFinite(el.duration) || el.seekable.length === 0) return;
      if (el.currentTime >= el.duration - 1) return;
      el.currentTime = el.duration;
    });
  };

  const releaseMute = () => {
    eachMedia((el) => {
      el.removeEventListener('timeupdate', reassert, true);
      if (!priorMuted.has(el)) return;
      el.muted = priorMuted.get(el);
      priorMuted.delete(el);
    });
  };

  const onStuck = () => {
    stuckTimer = null;
    stuck = true;
    health = 'stuck';
    releaseMute();
    emit();
  };

  const setAd = (next) => {
    if (next === adActive) return;
    adActive = next;
    if (next) {
      stuck = false;
      if (health === 'stuck') health = 'ok';
      if (shouldMute()) applyMute();
      attemptSkip();
      stuckTimer = setTimeout(onStuck, STUCK_MS);
    } else {
      clearTimeout(stuckTimer);
      stuckTimer = null;
      releaseMute();
    }
  };

  const setConfig = (nextEnabled, nextMode) => {
    const next = nextMode === 'block' ? 'block' : 'mute';
    if (nextEnabled === enabled && next === mode) return;
    enabled = nextEnabled;
    mode = next;
    if (shouldMute()) applyMute();
    else releaseMute();
    attemptSkip();
    emit();
  };

  const evaluate = () => {
    if (!bar) return;
    const cls = adapter.classify(bar.getAttribute(adapter.adAttribute));
    if (cls === 'stale') {
      health = 'stale';
    } else {
      if (health === 'stale') health = 'ok';
      setAd(cls === 'ad');
    }
    emit();
  };

  const stopSearch = () => {
    if (searchObserver) searchObserver.disconnect();
    searchObserver = null;
    clearTimeout(searchTimer);
    searchTimer = null;
  };

  const startSearch = () => {
    if (searchObserver) return;
    searchObserver = new MutationObserver(() => {
      if (!document.querySelector(adapter.barSelector)) return;
      stopSearch();
      acquireBar();
    });
    searchObserver.observe(document, { childList: true, subtree: true });
    // A document-wide observer is far too costly to leave running on pages that
    // have no player at all. Give up quickly; loadstart and play re-arm the
    // search if playback ever actually starts.
    searchTimer = setTimeout(stopSearch, SEARCH_MS);
  };

  function acquireBar() {
    const found = document.querySelector(adapter.barSelector);
    if (!found) {
      startSearch();
      return;
    }
    if (found !== bar) {
      if (barObserver) barObserver.disconnect();
      bar = found;
      barObserver = new MutationObserver(evaluate);
      barObserver.observe(bar, {
        attributes: true,
        attributeFilter: [adapter.adAttribute]
      });
    }
    evaluate();
  }

  const refresh = () => {
    if (bar && !bar.isConnected) {
      if (barObserver) barObserver.disconnect();
      barObserver = null;
      bar = null;
    }
    acquireBar();
    reassert();
  };

  const track = (el) => {
    tracked.add(new WeakRef(el));
    el.addEventListener('loadstart', refresh, true);
    el.addEventListener('play', refresh, true);
    // An ad element's duration is usually unknown when it is created, so retry
    // the skip the moment the player learns it.
    el.addEventListener('loadedmetadata', attemptSkip, true);
    el.addEventListener('durationchange', attemptSkip, true);
    if (shouldMute()) muteElement(el);
    attemptSkip();
    // A media element being created is the only reliable sign this page has a
    // player, so it is the cheapest moment to start looking for the bar.
    acquireBar();
  };

  const nativeCreate = Document.prototype.createElement;
  Document.prototype.createElement = function (tagName, options) {
    const el = nativeCreate.call(this, tagName, options);
    if (typeof tagName === 'string') {
      const tag = tagName.toLowerCase();
      if (tag === 'audio' || tag === 'video') track(el);
    }
    return el;
  };

  // Players build media with document.createElement, but the Audio constructor
  // bypasses that path entirely, so both are covered.
  const NativeAudio = window.Audio;
  window.Audio = function Audio(src) {
    const el = src === undefined ? new NativeAudio() : new NativeAudio(src);
    track(el);
    return el;
  };
  window.Audio.prototype = NativeAudio.prototype;

  document.addEventListener(CONFIG_EVENT, (event) => {
    // Runs in the main world, so any page script can fire this. Treat as input.
    let config;
    try {
      config = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!config || typeof config.enabled !== 'boolean') return;
    setConfig(config.enabled, config.mode);
    // The bridge subscribes after this script has already run, so it has missed
    // everything so far. Its config arriving is the cue to resend current state.
    lastPayload = '';
    emit();
  });
})();
