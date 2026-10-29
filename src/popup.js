const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const todayEl = document.getElementById('today');
const savedEl = document.getElementById('saved');
const spotifyEl = document.getElementById('spotifyCount');
const amazonEl = document.getElementById('amazonCount');
const enabledEl = document.getElementById('enabled');
const indicatorEl = document.getElementById('indicator');
const settingsEl = document.getElementById('settings');
const repoEl = document.getElementById('repo');

// Ads are ~30s each; time saved is an honest estimate, not a measurement.
const AD_SECONDS = 30;

// Day bucket key, matching how bridge.js writes history (UTC, YYYY-MM-DD).
const dayKey = () => new Date().toISOString().slice(0, 10);

const STATUS = {
  paused: ['Paused', 'idle'],
  stale: ['The player changed — detection needs an update', 'warn'],
  stuck: ['Stopped muting: the ad flag never cleared', 'warn'],
  waiting: ['Open the Spotify or Amazon Music web player to begin', 'idle'],
  ok: ['Active', 'idle']
};

const key = (state) => {
  if (!state.enabled) return 'paused';
  if (state.health === 'stale') return 'stale';
  if (state.health === 'stuck') return 'stuck';
  if (!state.lastSeen) return 'waiting';
  return 'ok';
};

const render = (state) => {
  const [text, tone] = STATUS[key(state)];
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
  countEl.textContent = state.adsMuted;
  todayEl.textContent = state.history[dayKey()] || 0;
  savedEl.textContent = Math.round((state.adsMuted * AD_SECONDS) / 60);
  spotifyEl.textContent = state.perSite.spotify || 0;
  amazonEl.textContent = state.perSite.amazon || 0;
  enabledEl.checked = state.enabled;
  indicatorEl.checked = state.indicator;
  document.documentElement.setAttribute('data-ready', '');
};

const read = () =>
  chrome.storage.local.get(
    {
      enabled: true,
      indicator: true,
      adsMuted: 0,
      perSite: {},
      history: {},
      health: 'ok',
      lastSeen: 0
    },
    render
  );

enabledEl.addEventListener('change', () =>
  chrome.storage.local.set({ enabled: enabledEl.checked })
);

indicatorEl.addEventListener('change', () =>
  chrome.storage.local.set({ indicator: indicatorEl.checked })
);

settingsEl.addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener(read);

repoEl.href = chrome.runtime.getManifest().homepage_url;
read();
