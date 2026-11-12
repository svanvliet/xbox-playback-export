# Agent-assisted acquisition

The normal experience is **agent gets presentation, renders, delivers MP4**.
The user approves browser access and handles sign-in/MFA, not JSON or DevTools.
This skill does not add browser tools to a host. Discover actual tools and read
their documented evaluation/download APIs; do not assume common tool names.

## Select a consented path

Prefer Microsoft Edge (`msedge`) whenever installed. Use Chrome only if Edge is
absent or explicitly selected by the user. **Acquisition always uses that browser's
normal default profile**, preferably the existing signed-in Playback tab. Never
create a separate, temporary, guest, incognito, or copied acquisition profile.
Confirm the actual selected window/profile using the host integration or native
UI; a tool reporting "Edge" or "Chrome" does not establish default-profile access.
If the profile cannot be confirmed, ask the user to select it rather than guess.

Prefer available computer-use on that explicitly selected, already-loaded
Xbox Playback tab. Ask and wait before controlling it. Use only that computer-use
server for all observations/actions on that browser. If supported by its policy,
the agent may run the reviewed expression through its page-evaluation API or
enter it into the tab's console using that server and handle the Blob download
through native UI. Never ask the user to paste code or bypass a console warning.
If the server is UI-only and this operation is not supported, explain the missing
capability. Browser-tool fallback must still access the approved default-profile
window; it must not substitute a newly launched isolated session.

Supported browser tools are another path, but require explicit permission before
attaching or controlling a browser. Use their documented evaluation and completed
download primitives. Never attach CDP as a backdoor into a computer-use-controlled
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
confirmed to be the approved default-profile tab, execute this function
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
If the tools cannot provide a private local handoff from the default-profile tab,
explain the missing capability and stop. Do not replace it with a new profile.

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
