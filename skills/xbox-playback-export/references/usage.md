# Local requirements and operation

Use Node.js **22.16 or later** (Node 24 recommended), installed Microsoft Edge or
Google Chrome, and an FFmpeg build with `ffmpeg`, `ffprobe`, H.264 `libx264`, and
AAC available on PATH. The tool does not install browsers or codecs for you.

On macOS, with Homebrew already installed:

```sh
brew install node ffmpeg
```

Install Edge or Chrome using its vendor's normal installer.

On Windows PowerShell, with winget available:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
winget install --id Gyan.FFmpeg --exact
winget install --id Microsoft.Edge --exact
```

Open a new shell after installation. Enterprise policy may require your
administrator's approved software distribution instead.

Check `node --version`, `ffmpeg -version`, and `ffprobe -version`. From a clone:

```sh
npm ci --prefix skills/xbox-playback-export --ignore-scripts --no-audit --no-fund
node skills/xbox-playback-export/scripts/cli.mjs --help
node skills/xbox-playback-export/scripts/cli.mjs export --url "https://www.xbox.com/en-US/playback" --consent headed --output "/private/playback.mp4"
```

URL acquisition requires prior permission to open a separate visible browser.
The user signs in themselves and loads their presentation; no JSON file is
needed. Use the user's selected official Playback URL, not a guessed account
link. See [acquisition](acquisition.md) for preferred existing-tab tool support,
consent boundaries, and evidence limits. For advanced/recovery imports only:

```sh
node skills/xbox-playback-export/scripts/cli.mjs validate --input "/private/presentation.json"
node skills/xbox-playback-export/scripts/cli.mjs export --input "/private/presentation.json" --output "/private/playback.mp4"
```

The same relative commands work in PowerShell; replace the private paths with
Windows paths such as `"C:\Users\you\Videos\presentation.json"`. Choose an existing,
writable output directory and a **new** filename. Pass `--browser chrome` for
Chrome or `--quality share` for a smaller encode.

The export records in real time, then encodes. Leave the computer awake and allow
a few minutes, several GB of temporary space, and network access. The browser
stays headless and muted during rendering; separate URL acquisition is visible
and muted until the user finishes loading Playback. Browser profiles, cookies and
login state are never exported/imported. Acquisition's fresh nonpersistent browser
necessarily handles the user's sign-in internally, but the helper never reads or
persists session state. No local server or exposed debugging listener is started.

## Limits and failure behavior

- Input is limited to 2 MiB and the supported three chapters.
- Asset downloads use HTTPS only, five explicit Xbox/Microsoft hosts, at most
  three redirects per resource, 256 total requests, 256 MiB/resource, 2 GiB total,
  and a 60-second timeout/resource. Redirect destinations are checked again.
- Backgrounds must be 1920x1080 and no longer than ten minutes each; the total
  presentation is limited to twenty minutes.
- The recorder must return 1920x1082 at 25 fps. A two-pixel timing band identifies
  actual scene boundaries; the encoder removes it and pre/post-roll. The encoder
  rejects missing/reordered markers and excessive duration drift.
- Music comes only from the Intro and Origin chapter `Music` scenes. It loops
  when shorter than its export segment, matching the authored looping setting.
  Background video audio and `playbackMusicUri` are not used.
- Output publication uses exclusive creation, including a final race check.
  Partial owned outputs are removed on failure/cancellation.
- Temporary downloads/recordings are deleted on normal success, errors and
  Ctrl+C. A crash, forced kill, power loss or OS failure can leave an
  `xbox-playback-export-*` folder in your OS temp directory; inspect and remove
  only that specific folder. This is not a secure-erasure guarantee.

Browser and FFmpeg failures intentionally omit raw diagnostics to avoid leaking
personalized values and media URLs. Do not collect full console/network dumps as
a workaround. Report the helper version, platform, failed phase, and bounded
error only.

## Validation scope

`npm test` from the repository root runs synthetic payload, download-policy,
timing-marker, exclusive-output, cancellation, acquisition, and FFmpeg integration
tests. It requires the skill's dependencies, FFmpeg and installed Edge, or Chrome
with `PLAYBACK_TEST_BROWSER=chrome`, but no account. Browser tests are headless,
muted and serve synthetic pages by interception, without live-site traffic.
The CI matrix runs these on Windows, macOS, and Linux. A green fixture job does
not establish real-account acquisition or rendering on that OS.

The original real-account proof and this reusable export are checked on macOS
with installed Edge. Other host installations and Windows real-account browser
exports remain experimental until separately exercised.
