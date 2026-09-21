# Balda — web build

The same 5×5 word game as the iOS app, as a static site. No framework, no build
step, no bundler: `public/` is exactly what gets served. Runs offline after the
first visit and installs to the iPhone home screen.

## Deploy

The Firebase project is **`blockhead-f8be6`**, already wired up in
`.firebaserc`. The site lands at <https://blockhead-f8be6.web.app>.

### From your Mac (works today)

    firebase deploy --only hosting

That's it — `firebase login` is already done and `.firebaserc` names the
project. There is a `Deploy Balda.command` on the Desktop that runs exactly
this if you'd rather double-click.

**Do not run `firebase init` in this directory.** It overwrites `firebase.json`,
which carries cache headers that matter: the lexicon and icons are immutable
for a year, HTML/JS/CSS revalidate on every load, and `sw.js` is never cached —
a cached service worker is how a PWA gets permanently stuck on an old release.
It also must not be run in your home directory, which is what happened the
first time.

### From GitHub (needs one secret)

`.github/workflows/firebase-hosting.yml` runs both test suites on every push
and deploys `main` to live. The test job works now; the deploy job needs a
service-account secret that only you can create:

1. Firebase console → ⚙ Project settings → **Service accounts** → *Generate new
   private key*. A JSON file downloads.
2. GitHub → repo → Settings → Secrets and variables → Actions → *New
   repository secret*.
3. Name it `FIREBASE_SERVICE_ACCOUNT_BLOCKHEAD_F8BE6` and paste the whole
   contents of that JSON file as the value.

Until that secret exists the deploy job fails while the test job still passes —
harmless, and the Mac command above keeps working regardless.

The `firebase init hosting` GitHub flow is the other way to create that secret,
but it failed for you on OAuth permissions. If you want to retry it, grant the
Firebase CLI app access at
<https://github.com/settings/connections/applications/89cf50f02ac6aaed3484>
first — and run it inside this repo, not in your home folder.

### On the iPhone

Open <https://blockhead-f8be6.web.app> in Safari, then Share → Add to Home
Screen. It launches full-screen and works offline after the first load.

### Staying inside the free tier

The whole app is **544 KB gzipped** — 442 KB of that is the word list, which
Hosting compresses and serves from its CDN. Against Spark's 360 MB/day transfer
limit that's roughly **677 cold loads per day**, and returning players cost
nothing because the service worker serves everything from cache. Storage use is
1.8 MB against a 10 GB allowance.

Nothing here uses Firestore, Auth, Cloud Functions or Cloud Storage, which is
deliberate: Functions and Cloud Storage both require the Blaze (pay-as-you-go)
plan, and Blaze has no built-in spending cap. Staying on Spark means you hit a
hard block rather than a bill.

## Run it locally / test on the phone

Double-click **`Start Balda.command`** (kept next to the `Balda-web` folder) —
it opens Terminal, starts the server and prints the address for the phone.
Nothing to type. From a shell it's the same thing:

    ./serve.py            # or ./serve.sh; add a port to override 8000

It prints both a `localhost` URL for this Mac and a `http://192.168.x.x:8000`
URL for the phone — same Wi-Fi network, nothing to deploy.

Use this rather than `python3 -m http.server`, which gets two things wrong for
this job:

- **No compression.** `words.txt` would go over the wire as the full 1.7 MB
  instead of 442 KB, four times the real production payload, making local
  testing look far slower than the deployed site.
- **It caches.** It answers conditional requests with 304, so Safari keeps
  serving a stale `main.js` after you've edited it — which is exactly how a
  fixed bug appears to still be present. `serve.py` sends `no-store` on every
  response, so what's on the phone is always what's on disk.

Verified behaviour: 442 KB gzipped for `words.txt`, `no-store` everywhere,
PNGs left uncompressed, 404 for missing paths.

One limitation of plain-HTTP LAN testing: it isn't a secure context, so the
service worker won't register and offline mode won't work. Everything else
behaves normally. Deploy to Hosting for the full PWA.

### Which build am I running?

`boot()` logs `Balda build N: 172724 words — fetch … ms, parse … ms`. Bump
`BUILD` at the top of `js/main.js` when you change shipped files, and bump
`CACHE` in `sw.js` too or an installed PWA will keep serving the old one.

## Playing a friend

Double-click **`Setup Multiplayer.command`** once. It creates a web app in the
Firebase project if there isn't one, writes `public/js/firebase-config.js`,
publishes `firestore.rules`, and redeploys. If the project has no Firestore
database yet it stops and tells you where to create one.

After that, ⋯ → **Play a friend** creates a game and gives you a link. Send it;
your friend opens it and plays. Each device polls for the other's move while
it's waiting, and stops polling on its own turn.

How it works, and the trade-offs:

- **No SDK, no Cloud Functions.** Functions need the paid Blaze plan. A game is
  one Firestore document holding the whole state as a JSON string plus a
  sequence number, read over the REST API. That keeps the document schema
  independent of the game model — nothing server-side to migrate.
- **Polling, not realtime listeners.** Two seconds, and only while waiting for
  the opponent. About 400 reads per game against Spark's 50,000/day, so
  roughly 125 games a day before the free tier notices.
- **Turn integrity is client-side.** The rules restrict writes to `games/*`
  with our two fields and a 50 kB cap, but they can't tell whose turn it is.
  Anyone with the link could in principle write a move. For a game with a
  friend that's the right trade; a real ranked mode would need Functions and
  therefore Blaze.
- **The link is the only protection.** No accounts, so treat a game link as a
  shared secret. The rules also carry an expiry date — a dead man's switch so
  a forgotten project doesn't stay open forever. Push it out when it lapses.

If `firebase-config.js` is missing or empty, "Play a friend" simply stays
hidden and everything else works normally.

## Tests

Both suites run headless with no dependencies, under either JavaScriptCore
(built into macOS) or Node:

    cd web
    jsc -m test/engine.test.mjs      # 29 rules / dictionary / search tests
    jsc -m test/ui.smoke.mjs         # boots the UI against a stub DOM

`jsc` lives at
`/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`.

The engine suite covers path legality, every rejection path in the rules,
timeout policies, difficulty ordering, and plays a full computer-vs-computer
game to a filled board. The smoke test boots `main.js` against a fake DOM that
only knows the ids declared in `index.html` — so a typo'd `getElementById`
fails the test instead of producing a dead button — then drives a real move
(tap a square, pick C, trace C→O→B, confirm) through the same handlers the
browser uses.

## Layout

| Path | What's in it |
|---|---|
| `public/js/dictionary.js` | Lexicon: offset table over the raw text, binary-search exact and prefix probes |
| `public/js/board.js` | Grid, orthogonal adjacency, path legality |
| `public/js/movefinder.js` | Move generator + difficulty selection |
| `public/js/game.js` | Rules, scoring, turn flow — no DOM, which is why it's testable |
| `public/js/main.js` | DOM rendering, pointer handling, dialogs, clock |
| `public/words.txt` | 172,724-word ENABLE lexicon, sorted |
| `public/sw.js` | Service worker: cache-first, versioned |
| `firebase.json` | Hosting config and cache headers |

## Performance

Measured under JavaScriptCore on an Intel Mac. A recent iPhone runs JS at least
as fast, so treat these as upper bounds for the phone.

| | |
|---|---|
| Parse 172,724 words into the offset table | **12 ms** median (12–20 ms) |
| 200,000 prefix probes | 52 ms (~0.26 µs each) |
| Hardest computer turn | **33 ms** (mean 13 ms over 100 self-play turns) |
| Dictionary resident memory | 0.86 MB table + 1.7 MB source = **2.6 MB** |
| Same list as `text.split('\n')` | 6.59 MB |

The search runs on the main thread because 33 ms doesn't justify a Web Worker,
and there's a deliberate 350 ms pause before the computer plays so its move
doesn't appear instantaneously.

The offset table is a **memory** optimisation, not a speed one: it's slower to
build than the naive split (12 ms vs 8 ms) and buys a 2.5× smaller footprint.

### What loading should look like

`boot()` logs a line like `Balda: 172724 words — fetch 180 ms, parse 13 ms` to
the console; read it in Safari Web Inspector with the phone attached over USB.

- **First load over Wi-Fi from Hosting:** roughly 0.3–1 s in total, nearly all
  of it network. 544 KB gzipped over the CDN, then ~13 ms of parsing.
- **Every later load:** no network at all — the service worker serves from
  cache, so it's the decode and parse only, well under 100 ms.
- **Over `serve.sh` on the LAN:** slower than production, and expected to be.
  Python's `http.server` does not gzip, so `words.txt` goes over the wire as the
  full **1.7 MB** rather than 442 KB, and there's no service worker on plain
  HTTP, so every reload re-fetches all of it.

If it sits on "Loading dictionary…" for more than a few seconds on Wi-Fi, it's
not slow parsing — check the network tab for a 404 on `words.txt`.

## Differences from the iOS build

- Word definitions link out to Merriam-Webster in a new tab; the native app uses
  the built-in iOS dictionary, which has no web equivalent.
- Press-and-hold to highlight a word's path is hover on desktop, tap on mobile
  (tapping also opens the word sheet).
- Settings persist in `localStorage` rather than `UserDefaults`.
