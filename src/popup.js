const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const enabledEl = document.getElementById('enabled');
const indicatorEl = document.getElementById('indicator');
const repoEl = document.getElementById('repo');

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
  enabledEl.checked = state.enabled;
  indicatorEl.checked = state.indicator;
};

const read = () =>
  chrome.storage.local.get(
    { enabled: true, indicator: true, adsMuted: 0, health: 'ok', lastSeen: 0 },
    render
  );

enabledEl.addEventListener('change', () =>
  chrome.storage.local.set({ enabled: enabledEl.checked })
);

indicatorEl.addEventListener('change', () =>
  chrome.storage.local.set({ indicator: indicatorEl.checked })
);

chrome.storage.onChanged.addListener(read);

repoEl.href = chrome.runtime.getManifest().homepage_url;
read();
