(() => {
  'use strict';

  const STATE_EVENT = '__quietly_state';
  const CONFIG_EVENT = '__quietly_config';
  const DEFAULTS = { enabled: true, indicator: true, siteConfig: {} };

  // Which player this tab is, so stats and settings are keyed by site. The
  // content script only runs on these two hosts, so one always matches; the
  // __quietlySite fallback exists only for the file:// test harness.
  const SITE = location.hostname.includes('spotify.com')
    ? 'spotify'
    : location.hostname.includes('music.amazon.')
      ? 'amazon'
      : window.__quietlySite;

  // Ad-count history is bucketed per day and pruned to this many days.
  const HISTORY_DAYS = 30;
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);

  let showIndicator = true;
  let dismissed = false;
  let pill = null;
  let ticker = null;
  let startedAt = 0;
  let counted = false;

  // The extension can be reloaded or updated while a supported tab is open,
  // which invalidates this context and makes every chrome.* call throw.
  const store = (values) => {
    try {
      chrome.storage.local.set(values);
    } catch {
      /* context invalidated; the page keeps working without us */
    }
  };

  // One ad counted: bump the all-time total, this site's total, and today's
  // bucket, then drop day buckets older than the retention window.
  const countAd = () => {
    try {
      chrome.storage.local.get(
        { adsMuted: 0, perSite: {}, history: {} },
        ({ adsMuted, perSite, history }) => {
          perSite[SITE] = (perSite[SITE] || 0) + 1;
          const today = dayKey(Date.now());
          history[today] = (history[today] || 0) + 1;
          const cutoff = dayKey(Date.now() - HISTORY_DAYS * 86400000);
          for (const day in history) if (day < cutoff) delete history[day];
          store({ adsMuted: adsMuted + 1, perSite, history });
        }
      );
    } catch {
      /* context invalidated */
    }
  };

  const sendConfig = (enabled, mode) => {
    document.dispatchEvent(
      new CustomEvent(CONFIG_EVENT, { detail: JSON.stringify({ enabled, mode }) })
    );
  };

  // A site is muting when both the master switch and its own switch are on; its
  // mode (mute vs skip) is per-site and defaults to mute.
  const computeAndSend = (values) => {
    const sc = (values.siteConfig && values.siteConfig[SITE]) || {};
    const enabled = values.enabled !== false && sc.enabled !== false;
    const mode = sc.mode === 'block' ? 'block' : 'mute';
    sendConfig(enabled, mode);
  };

  const tick = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    pill.textContent = `Ad muted · ${seconds}s`;
  };

  const hidePill = () => {
    clearInterval(ticker);
    ticker = null;
    if (!pill) return;
    pill.remove();
    pill = null;
  };

  const showPill = () => {
    if (pill || dismissed) return;
    pill = document.createElement('div');
    pill.className = 'quietly-pill';
    pill.setAttribute('role', 'status');
    pill.title = 'Click to hide until the page reloads';
    pill.addEventListener('click', () => {
      dismissed = true;
      hidePill();
    });
    startedAt = Date.now();
    tick();
    document.documentElement.appendChild(pill);
    ticker = setInterval(tick, 1000);
  };

  document.addEventListener(STATE_EVENT, (event) => {
    let state;
    try {
      state = JSON.parse(event.detail);
    } catch {
      return;
    }
    store({ health: state.health, lastSeen: Date.now() });

    if (!state.ad) counted = false;

    if (!state.muting) {
      hidePill();
      return;
    }
    if (!counted) {
      counted = true;
      countAd();
    }
    if (showIndicator) showPill();
  });

  chrome.storage.local.get(DEFAULTS, (values) => {
    showIndicator = values.indicator !== false;
    computeAndSend(values);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.indicator) {
      showIndicator = changes.indicator.newValue !== false;
      if (!showIndicator) hidePill();
    }
    // The master switch and per-site config both change the effective state,
    // and recomputing needs the whole settings object, not just the delta.
    if (changes.enabled || changes.siteConfig) {
      chrome.storage.local.get(DEFAULTS, computeAndSend);
    }
  });
})();
