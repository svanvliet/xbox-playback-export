# Agent-assisted acquisition

The normal experience is **agent gets presentation, renders, delivers MP4**.
The user approves browser access and handles sign-in/MFA, not JSON or DevTools.
This skill does not add browser tools to a host. Discover actual tools and read
their documented evaluation/download APIs; do not assume common tool names.

## Select a consented path

Prefer available computer-use on the user's explicitly selected, already-loaded
Xbox Playback tab. Ask and wait before controlling it. Use only that computer-use
server for all observations/actions on that browser. If supported by its policy,
the agent may run the reviewed expression through its page-evaluation API or
enter it into the tab's console using that server and handle the Blob download
through native UI. Never ask the user to paste code or bypass a console warning.
If the server is UI-only and this operation is not supported, explain the missing
capability and offer the separate session below, with its own consent.

Supported browser tools are another path, but require explicit permission before
attaching or controlling a browser. Use their documented evaluation and completed
download primitives. Never attach CDP as a backdoor into a computer-use-controlled
browser. No copying profiles, exporting cookies, changing the user's launch
flags, killing their browser, or public debugging listeners.

**Fallback is for absent capabilities or a recoverable session loss only.**
A refusal, user denial, missing OS permission, policy restriction, unsupported
build, or invalid payload is a stop, not permission to try a different tool.
After a recoverable session loss, explain it and obtain consent for a distinct
session; do not silently reopen anything. A cancelled acquisition stays cancelled.

## Separate Playwright browser: executable default fallback

After permission for a fresh visible browser, the agent runs:

```sh
node "SKILL_DIR/scripts/cli.mjs" export --url "https://www.xbox.com/en-US/playback" --consent headed --output "/private/playback.mp4"
```

Use the official Playback URL selected with the user; the URL above is an example,
not a validated current entrypoint. The helper checks HTTPS `www.xbox.com`, no
credentials/nonstandard port, and a locale-optional `/playback` path. `--browser
chrome` selects installed Chrome instead of Edge. No browser download is needed.
The flag records consent already obtained; it is not permission itself.

The muted browser is a fresh, isolated, nonpersistent session. The user signs in
directly and opens their presentation; the agent does not read or fill login,
password, or MFA fields. The helper inspects presentation data only once on an
official Playback page. It waits at most ten minutes, fails on unsupported data,
and closes only its own browser. It then renders with the existing silent
headless renderer. Presentation data stays in process memory; there is no JSON
file for the user to manage. Closing the tab, timeout, or Ctrl+C stops acquisition.

## Existing tool session: shared expression and private handoff

Read [acquire.js](acquire.js) as text. It is a function expression, not a second
adapter to rewrite. Evaluate it as `(<contents>)()` for bounded JSON text, or
`(<contents>)({download:true})` to start a Blob download. Do not return the full
JSON through a tool's chat transcript. Prefer a completed download saved directly
to an agent-created private job folder outside the repo.

For browser tools that explicitly support a Playwright `page`, local module
imports, and filesystem access on the **same local host**, execute this function
through that tool's documented code primitive. Replace `SKILL_DIR` with the actual
installed absolute directory; do not assume this code primitive exists:

```js
async page => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { savePresentationFromPage } = await import(
    pathToFileURL(path.join('SKILL_DIR', 'scripts/acquire.mjs')).href);
  const job = await fs.mkdtemp(path.join(os.tmpdir(), 'xbox-playback-acquire-'));
  await fs.chmod(job, 0o700);
  const input = path.join(job, 'presentation.json');
  try {
    await savePresentationFromPage(page, input);
    return { input, jobDirectory: job };
  } catch (error) {
    await fs.rm(job, { recursive: true, force: true });
    throw error;
  }
}
```

The helper installs its download listener before extraction, waits for completion
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
If the tools cannot provide a private local handoff, use the separate session
with consent, or explain the missing capability.

## Bounded data and evidence

All paths share one expression: official origin/path, pinned route script
`PlaybackVideoPage.5cadca40.chunk.js`, `main[data-experience-completed]`, its own
`__reactFiber$` key, at most 64 `.return` ancestors, `memoizedProps.payload`.
Missing/not-ready state waits only within bounds. Unsupported structure fails
closed. Rendering separately verifies all bundle/style SHA-256 fingerprints.

Only allowlisted presentation fields are copied at **every nested level**:
chapter scenes/text/game summaries/cues, common text, and gamer display info.
Extra auth/store fields, getters on copied fields, objects in scalar slots, and
serialization hooks are not copied/executed. Unused `playbackMusicUri` is omitted.
No Redux/network/session dumps or broadened traversal. Data is limited to 2 MiB,
bounded arrays/nodes/strings, and validated again before use.

Synthetic tests exercise the real headless browser expression, completed Blob
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
