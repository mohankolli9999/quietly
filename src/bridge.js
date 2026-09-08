(() => {
  'use strict';

  const STATE_EVENT = '__quietly_state';
  const CONFIG_EVENT = '__quietly_config';
  const DEFAULTS = { enabled: true, indicator: true, adsMuted: 0 };

  let showIndicator = true;
  let dismissed = false;
  let pill = null;
  let ticker = null;
  let startedAt = 0;
  let counted = false;

  // The extension can be reloaded or updated while a Spotify tab is open,
  // which invalidates this context and makes every chrome.* call throw.
  const store = (values) => {
    try {
      chrome.storage.local.set(values);
    } catch {
      /* context invalidated; the page keeps working without us */
    }
  };

  const sendConfig = (enabled) => {
    document.dispatchEvent(
      new CustomEvent(CONFIG_EVENT, { detail: JSON.stringify({ enabled }) })
    );
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
      try {
        chrome.storage.local.get({ adsMuted: 0 }, ({ adsMuted }) =>
          store({ adsMuted: adsMuted + 1 })
        );
      } catch {
        /* context invalidated */
      }
    }
    if (showIndicator) showPill();
  });

  chrome.storage.local.get(DEFAULTS, (values) => {
    showIndicator = values.indicator !== false;
    sendConfig(values.enabled !== false);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) sendConfig(changes.enabled.newValue !== false);
    if (changes.indicator) {
      showIndicator = changes.indicator.newValue !== false;
      if (!showIndicator) hidePill();
    }
  });
})();
