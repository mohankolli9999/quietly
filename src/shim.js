(() => {
  'use strict';

  // Per-site detection. Everything else in this file is site-agnostic: the
  // mute engine below never mentions Spotify or Amazon.
  const SPOTIFY = {
    name: 'spotify',
    barSelector: '[data-testid="now-playing-bar"]',
    adAttribute: 'data-testadtype',
    // Spotify renders this unconditionally from its own isAd(state.item), so a
    // missing attribute means the markup changed under us — report it as stale.
    classify: (v) => (v === null ? 'stale' : v === 'ad-type-ad' ? 'ad' : 'clear')
  };

  const AMAZON = {
    name: 'amazon',
    barSelector: '#transport music-horizontal-item',
    adAttribute: 'primary-href',
    // Songs carry primary-href="#" (or none); ads carry a real click-through
    // URL. A song and a renamed attribute look identical here, so we never
    // report stale for Amazon — a lost node surfaces as "waiting" instead.
    classify: (v) => (v === null || v === '#' ? 'clear' : 'ad')
  };

  // hostname is empty under file:// (the test harness), where __quietlySite
  // picks the adapter instead. In a real tab hostname always wins, so a page
  // script cannot use that global to steer us.
  const site = location.hostname
    ? (location.hostname.includes('spotify.com') ? 'spotify'
      : location.hostname.includes('music.amazon.') ? 'amazon'
      : null)
    : (window.__quietlySite || null);
  const adapter = { spotify: SPOTIFY, amazon: AMAZON }[site];
  if (!adapter) return;

  const STATE_EVENT = '__quietly_state';
  const CONFIG_EVENT = '__quietly_config';

  // No real ad runs this long. If the flag is still set we assume our own
  // reading is wrong and stop muting rather than leave the user in silence.
  const STUCK_MS = 180000;

  const SEARCH_MS = 30000;

  let enabled = true;
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

  const emit = () => {
    const payload = JSON.stringify({
      ad: adActive,
      muting: shouldMute(),
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
  };

  const muteElement = (el) => {
    if (!priorMuted.has(el)) priorMuted.set(el, el.muted);
    el.muted = true;
    // The player re-reads muted from its own cache on every load(), so a single
    // assignment at ad start is not enough.
    el.addEventListener('timeupdate', reassert, true);
  };

  const applyMute = () => eachMedia(muteElement);

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
      stuckTimer = setTimeout(onStuck, STUCK_MS);
    } else {
      clearTimeout(stuckTimer);
      stuckTimer = null;
      releaseMute();
    }
  };

  const setEnabled = (next) => {
    if (next === enabled) return;
    enabled = next;
    if (shouldMute()) applyMute();
    else releaseMute();
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
    if (shouldMute()) muteElement(el);
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
    setEnabled(config.enabled);
    // The bridge subscribes after this script has already run, so it has missed
    // everything so far. Its config arriving is the cue to resend current state.
    lastPayload = '';
    emit();
  });
})();
