const el = (id) => document.getElementById(id);
const enabledEl = el('enabled');
const indicatorEl = el('indicator');
const spotifyEnabledEl = el('spotify-enabled');
const amazonEnabledEl = el('amazon-enabled');
const amazonModeEl = el('amazon-mode');
const totalEl = el('total');
const resetEl = el('reset');
const repoEl = el('repo');
const versionEl = el('version');

const DEFAULTS = { enabled: true, indicator: true, siteConfig: {}, adsMuted: 0 };

const render = (s) => {
  enabledEl.checked = s.enabled !== false;
  indicatorEl.checked = s.indicator !== false;
  const sc = s.siteConfig || {};
  const spotify = sc.spotify || {};
  const amazon = sc.amazon || {};
  spotifyEnabledEl.checked = spotify.enabled !== false;
  amazonEnabledEl.checked = amazon.enabled !== false;
  amazonModeEl.value = amazon.mode === 'block' ? 'block' : 'mute';
  totalEl.textContent = s.adsMuted;
  document.documentElement.setAttribute('data-ready', '');
};

const read = () => chrome.storage.local.get(DEFAULTS, render);

// Merge one site's patch into siteConfig without clobbering the other site.
const patchSite = (site, patch) =>
  chrome.storage.local.get({ siteConfig: {} }, ({ siteConfig }) => {
    siteConfig[site] = { ...siteConfig[site], ...patch };
    chrome.storage.local.set({ siteConfig });
  });

enabledEl.addEventListener('change', () =>
  chrome.storage.local.set({ enabled: enabledEl.checked })
);
indicatorEl.addEventListener('change', () =>
  chrome.storage.local.set({ indicator: indicatorEl.checked })
);
spotifyEnabledEl.addEventListener('change', () =>
  patchSite('spotify', { enabled: spotifyEnabledEl.checked })
);
amazonEnabledEl.addEventListener('change', () =>
  patchSite('amazon', { enabled: amazonEnabledEl.checked })
);
amazonModeEl.addEventListener('change', () =>
  patchSite('amazon', { mode: amazonModeEl.value })
);
resetEl.addEventListener('click', () =>
  chrome.storage.local.set({ adsMuted: 0, perSite: {}, history: {} })
);

chrome.storage.onChanged.addListener(read);

const manifest = chrome.runtime.getManifest();
repoEl.href = manifest.homepage_url;
versionEl.textContent = 'v' + manifest.version;
read();
