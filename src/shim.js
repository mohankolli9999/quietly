(() => {
  'use strict';

  const BAR = '[data-testid="now-playing-bar"]';
  const AD = 'ad-type-ad';
  const STATE_EVENT = '__quietly_state';
  const CONFIG_EVENT = '__quietly_config';

  // No real ad runs this long. If the flag is still set we assume our own
  // reading is wrong and stop muting rather than leave the user in silence.
  const STUCK_MS = 180000;

  let enabled = true;
  let adActive = false;
  let stuck = false;
  let health = 'ok';
  let bar = null;
  let barObserver = null;
  let searchObserver = null;
  let stuckTimer = null;
  let lastPayload = '';

  // WeakRef so a long session does not retain every media element Spotify
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
    // Spotify re-reads muted from its own cache on every load(), so a single
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
    const value = bar.getAttribute('data-testadtype');
    if (value === null) {
      health = 'stale';
    } else {
      if (health === 'stale') health = 'ok';
      setAd(value === AD);
    }
    emit();
  };

  const startSearch = () => {
    if (searchObserver) return;
    searchObserver = new MutationObserver(() => {
      if (!document.querySelector(BAR)) return;
      searchObserver.disconnect();
      searchObserver = null;
      acquireBar();
    });
    searchObserver.observe(document, { childList: true, subtree: true });
  };

  function acquireBar() {
    const found = document.querySelector(BAR);
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
        attributeFilter: ['data-testadtype']
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

  // Spotify builds its player with document.createElement, but the Audio
  // constructor bypasses that path entirely, so both are covered.
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

  acquireBar();
})();
