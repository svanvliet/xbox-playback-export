# Agent-assisted acquisition

The normal experience is **agent gets presentation, renders, delivers MP4**.
The user approves browser access and handles sign-in/MFA, not JSON or DevTools.
This skill does not add browser tools to a host. Discover actual tools and read
their documented evaluation/download APIs; do not assume common tool names.

## Select a consented path

Prefer Microsoft Edge (`msedge`) whenever installed. Use Chrome only if Edge is
absent or explicitly selected by the user. **Acquisition always uses that browser's
normal default profile**, opening its normal browser window if needed. Never
create a separate, temporary, guest, incognito, or copied acquisition profile.
Confirm the actual selected window/profile using the host integration or native
UI; a tool reporting "Edge" or "Chrome" does not establish default-profile access.
Resolve profile selection with supported tools first; ask only when the actual
selection remains genuinely ambiguous, not whether the browser/page is open.

Ask once for consent covering **open the normal browser, navigate to Playback,
and acquire the presentation**, then wait. Do not ask "is Playback open?" or make
the user open the browser/page manually. This consent does not bypass native
approval prompts. After approval, use the computer-use provider's documented
app discovery/open and tab/navigation actions to:

1. Discover the installed preferred browser and open its normal default-profile
   window if it is not running. Use only this provider, not shell launchers,
   AppleScript, another window controller, or CDP.
2. Reuse a positively identified official **`/xboxplayback` video tab**, including
   localized variants. `/playback` is a distinct archive and must not be reused
   for extraction. Otherwise create a fresh tab in that default-profile window.
   Prefer the selected official Xbox tab's observed locale, e.g.
   `https://www.xbox.com/fr-FR/xboxplayback`; if it has no locale, use another
   observed Xbox tab's locale. With no known locale, navigate to
   **`https://www.xbox.com/xboxplayback`** and follow the site's redirects.
   Use observed navigation/redirects, never invented translated slugs or an
   arbitrary English fallback. Do not ask users to identify a locale the site
   can resolve. Preserve unrelated tabs, history and unsaved content; do not close
   the user's browser.
3. Wait for navigation and bounded presentation readiness, leaving login/MFA to
   the user. Apply the origin/path/build guards after navigation. A missing
   initial Playback page is a reason to navigate, not ask a readiness question
   or report an unsupported page.
4. Acquire with the shared expression and private completed-download handoff.

Use only that computer-use server for all observations/actions on that browser.
If supported by its policy,
the agent may run the reviewed expression through its page-evaluation API or
enter it into the tab's console using that server and handle the Blob download
through native UI. Never ask the user to paste code or bypass a console warning.
If the server is UI-only and this operation is not supported, explain the missing
capability. Browser-tool fallback must still access the approved default-profile
window; it must not substitute a newly launched isolated session.

Supported browser tools are another path, but require explicit permission before
attaching or controlling a browser. Use their documented evaluation and completed
download primitives and the same automatic new-tab/navigation rule. Do not assume
an initially unrelated tab means acquisition is unavailable. Never attach CDP as a backdoor into a computer-use-controlled
browser. No copying profiles, exporting cookies, changing the user's launch
flags, killing their browser, or public debugging listeners.

**Fallback is for absent capabilities or a recoverable session loss only.**
A refusal, user denial, missing OS permission, policy restriction, unsupported
build, or invalid payload is a stop, not permission to try a different tool.
After a recoverable session loss, explain it and obtain consent before reconnecting
through a supported integration to the default-profile window. Do not silently
reopen anything. A cancelled acquisition stays cancelled.

## No separate-profile fallback

The previous `export --url ... --consent headed` mode is removed. Old invocations
fail explicitly before launching a browser; they do not silently create a clean
profile. The renderer still uses installed Edge by default in a **fresh silent
headless context**, keeping account state out of downloaded assets and recordings.
That isolated renderer is not used for acquisition or sign-in.

Plain Playwright launch/newContext does not reuse an existing default profile.
Pointing a new automation process at the daily profile can conflict with profile
locks and browser debugging restrictions; this plugin does not do it. It also
does not copy that profile, export cookies, or restart the user's browser with
debugging flags. If no approved tool can access the default-profile tab and provide
the private handoff below, report the missing capability and stop. An explicit
already-exported JSON is still supported for recovery.

## Existing tool session: shared expression and private handoff

Read [acquire.js](acquire.js) as text. It is a function expression, not a second
adapter to rewrite. Evaluate it as `(<contents>)()` for bounded JSON text, or
`(<contents>)({download:true})` to start a Blob download. Do not return the full
JSON through a tool's chat transcript. Prefer a completed download saved directly
to an agent-created private job folder outside the repo.

For browser tools that explicitly support a Playwright `page`, local module
imports, and filesystem access on the **same local host**, and whose `page` is
confirmed to belong to the approved default-profile context, execute this function
through that tool's documented code primitive. Replace `SKILL_DIR` with the actual
installed absolute directory; do not assume this code primitive exists:

```js
async page => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { preparePlaybackPage, acquireFromPage, savePresentationFromPage } = await import(
    pathToFileURL(path.join('SKILL_DIR', 'scripts/acquire.mjs')).href);
  const job = await fs.mkdtemp(path.join(os.tmpdir(), 'xbox-playback-acquire-'));
  await fs.chmod(job, 0o700);
  const input = path.join(job, 'presentation.json');
  try {
    const playbackPage = await preparePlaybackPage(page.context(), { preferredPage: page });
    await acquireFromPage(playbackPage);
    await savePresentationFromPage(playbackPage, input);
    return { input, jobDirectory: job };
  } catch (error) {
    await fs.rm(job, { recursive: true, force: true });
    throw error;
  }
}
```

`preparePlaybackPage` reuses a positively identified official Playback tab or
creates a new tab and navigates to the canonical route (30-second navigation
bound), using the selected Xbox tab's locale first, other observed Xbox locales
second, or the locale-neutral entry with normal site redirects. It never replaces
an unrelated tab or launches a browser/profile. Resulting pages must still pass
the official-origin/video-route guard before evaluation; login redirects are
left for the user and never inspected for state.
`acquireFromPage` waits up to ten minutes for the allowlisted presentation, without
reading login pages. Navigation failures/refusals stop rather than trigger another
browser. These helpers do not establish profile identity or consent: the host must.
The host can supply an AbortSignal to cancel further work.

The download helper installs its listener before extraction, waits for completion
(30-second bound), bounds the stream to 2 MiB, reuses payload validation, writes
with exclusive creation and mode `0600`, and deletes its browser download.
It never closes the host's tab. It removes its partial output on failure.
Do not pass an existing destination or save to the user's normal Downloads folder.

If the tool exposes only native evaluation/download APIs, use the same expression,
choose a new path in a private `0700` job folder, wait for the tool's explicit
completed-download result, restrict file permissions, then run `cli.mjs validate`
and `export --input ... --output ...`. Do not guess paths, parse partial downloads,
use a shared downloads folder, or collect unrelated files. After export or
cancellation, delete only the agent-owned JSON and job directory. Respect
Windows ACLs; POSIX mode bits alone do not establish Windows access control.
If the tools cannot provide a private local handoff from the default-profile tab,
explain the missing capability and stop. Do not replace it with a new profile.

## Bounded data and evidence

All paths share one expression: official origin/path, pinned route script
`PlaybackVideoPage.5cadca40.chunk.js`, `main[data-experience-completed]`, its own
`__reactFiber$` key, at most 64 `.return` ancestors, `memoizedProps.payload`.
Missing/not-ready state waits only within bounds. Unsupported structure fails
closed. Rendering separately verifies all bundle/style SHA-256 fingerprints.
The guard accepts locale-neutral or localized `/xboxplayback` paths, never the
`/playback` archive or arbitrary Xbox pages. A route mismatch is not a build
change. No video chunk yet produces `PLAYBACK_ROUTE_NOT_READY` (bounded wait);
an observed incompatible production video chunk produces
`PLAYBACK_UNSUPPORTED_BUILD` (stop); missing presentation produces
`PLAYBACK_NOT_READY` (bounded wait); malformed presentation produces
`PLAYBACK_INVALID_DATA` (stop). `PlaybackVideoPage.js` is only a local reference
filename, not the accepted production script URL.

A public unauthenticated check on November 12, 2026 observed the neutral entry
redirect to `/en-US/xboxplayback` for that request and a French page at
`/fr-FR/xboxplayback`. The pinned public production route script still matched
SHA-256 `d9aa886afa01d39f5c1b5e64c38d828389dd2957bfccd0199a78c02cfd686c2d`.
This verifies the navigation entry and original script, not signed-in acquisition
or localized rendering.

Only allowlisted presentation fields are copied at **every nested level**:
chapter scenes/text/game summaries/cues, common text, and gamer display info.
Extra auth/store fields, getters on copied fields, objects in scalar slots, and
serialization hooks are not copied/executed. Unused `playbackMusicUri` is omitted.
No Redux/network/session dumps or broadened traversal. Data is limited to 2 MiB,
bounded arrays/nodes/strings, and validated again before use.

Synthetic tests exercise missing-page -> new-tab navigation -> acquisition,
existing official-tab reuse, preservation of unrelated tabs, navigation refusal
and cancellation, selected-locale navigation, neutral-entry redirects, archive
rejection, pending versus incompatible route chunks, the real headless browser expression, completed Blob
download, exact privacy projection, cancellation/timeouts, existing-file
protection, and stop-without-fallback behavior. The original Fiber path was used
successfully in the local proof. **Fresh live-site acquisition and cross-host
computer-use integration have not been revalidated.** A synthetic official-URL
page served locally by test interception is not a real authenticated-site test.

English macOS/Edge import rendering remains verified; other locale/variant and
live acquisition support is experimental. The user can optionally supply an
already-exported local JSON through `--input` for recovery. Manual extraction is
not the normal workflow. Never upload private presentation data for processing.
Asset requests still reach the documented Xbox/Microsoft public-media hosts.
