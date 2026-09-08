# Quietly

Mutes audio ads on the Spotify and Amazon Music web players.

No host permissions. No background service worker. No tracking. No remote code.
No build step — the files in this repository are exactly the files that run.

> Not affiliated with, endorsed by, or connected to Spotify AB or Amazon.com, Inc.

## What it does

When the Spotify or Amazon Music web player starts an audio ad, Quietly mutes
its audio element and shows a small "Ad muted" pill. When the ad ends, it
restores the previous mute state. That is the whole feature.

The ad still plays. The player advances on its own. Nothing is skipped, seeked,
clicked, blocked, or faked.

## Why it works this way

The obvious design — click the skip button, or jump `currentTime` to the end —
is what most extensions in this category do, and it is why most of them have
a long tail of "it froze my player" reviews. Driving the transport control
mutates Spotify's playback state machine, and repeated skips trip a server-side
rate limiter.

Muting cannot wedge playback. Progress reporting is position-driven and
volume-independent, so the ad completes and the next track starts unaided.
The failure mode of this design is "you hear an ad", not "your player is stuck".

## How it works

Two content scripts, both matching `https://open.spotify.com/*` and
`https://music.amazon.com/*`.

**`src/shim.js`** (main world, `document_start`)

Spotify never puts an `<audio>` element in the DOM — it builds a detached one
with `document.createElement` and keeps the reference internally. There is no
selector that finds it. So the shim patches `Document.prototype.createElement`
before Spotify's bundle loads and keeps a `WeakRef` to every media element the
page creates.

Ad state comes from an attribute Spotify writes itself:

```
[data-testid="now-playing-bar"][data-testadtype="ad-type-ad"]
```

The value is rendered unconditionally from Spotify's own `isAd(state.item)`, so
it is language-independent and not a hashed class name. A single
`MutationObserver` with `attributeFilter: ['data-testadtype']`, scoped to that
one node, does all the detection. **There is no polling anywhere in this
extension.**

Finding that node the first time needs a document-wide observer, so that one is
armed only once Spotify actually creates a media element, and gives up after
30 seconds. Spotify pages with no player never pay for it.

Spotify re-reads `muted` from its own cache on every `load()`, so the mute is
re-asserted on `timeupdate` while an ad is playing, and only then.

On Amazon Music the same engine runs against a different marker: the now-playing
`music-horizontal-item` under `#transport` carries a `primary-href` that is `#`
for a song and a real click-through URL for an ad. Only the selector and that
attribute name differ per site — the shim picks the right one by hostname
through a small adapter, and the mute engine itself is identical.

**`src/bridge.js`** (isolated world, `document_start`)

Owns the counter, the settings, and the on-page pill. Talks to the shim over a
`CustomEvent` because the two worlds do not share JavaScript globals.

## Permissions

`storage`, and nothing else — there is no `host_permissions` key. The content
scripts still declare a host match for `open.spotify.com` and `music.amazon.com`,
so installing from the Web Store shows the access notice for those two sites
("Read and change your data on open.spotify.com and music.amazon.com"); loaded
unpacked it prompts for nothing. The extension cannot touch any other site and
makes no network requests of its own.

## Install

Not on the Chrome Web Store yet.

1. `git clone https://github.com/mohankolli9999/quietly`
2. Open `chrome://extensions`, enable **Developer mode**
3. **Load unpacked**, select the cloned folder

Chrome 111+ or Edge 111+ (needs `world: "MAIN"` content scripts).

## Known limitations

- **Muting is not blocking.** Ads are downloaded and played silently. Blocking
  them at the network layer would need a `declarativeNetRequest` permission,
  which Chrome surfaces to the user as *"Block content on any page"*, and the
  Chromium redirect bug tracked at
  [crbug/375395102](https://issues.chromium.org/issues/375395102) currently
  breaks that approach for Spotify media specifically.
- **A short blip is possible at ad start**, between audio beginning and Spotify
  writing the ad attribute.
- **If you mute Spotify yourself during an ad**, Quietly will unmute when the ad
  ends, because it cannot tell your mute apart from its own.
- **Detection depends on one Spotify attribute.** If Spotify renames it the
  popup will say "detection needs an update" rather than silently doing nothing.
  Please open an issue if you see that.
- **Not verified against a live player.** Spotify behaviour is derived from
  reading its shipped bundle (and is covered by DOM tests). Amazon Music
  detection is derived from public research, not a live capture — if Amazon's
  `primary-href` marker has drifted, Quietly won't detect its ads until the
  selector is updated.

## Roadmap

- Firefox (should be a manifest change — no background worker, no permissions)
- Verify Amazon Music detection against a live player, and — if its queue
  allows it — skip ads outright instead of muting

## Tests

`src/shim.js` ships with a dependency-free behaviour test that drives it
against a real DOM in headless Chrome:

```
test/run.sh
```

It builds the detached `<audio>` element the way Spotify does, cycles the
`data-testadtype` attribute through an ad, and asserts the player is muted at
ad start, re-muted after Spotify resets it mid-ad, and restored — including a
mute you set yourself — when the ad ends. The enable/disable handshake and the
`stale` signal for a renamed attribute are covered too. `test/amazon.test.html`
runs the same engine against Amazon's `primary-href` marker, and `test/run.sh`
runs both suites. There is still no live-player test; see the last point under
[Known limitations](#known-limitations).

## Contributing

Issues and pull requests welcome. Keep it dependency-free and keep the
permission set empty.

## License

MIT — see [LICENSE](LICENSE).
