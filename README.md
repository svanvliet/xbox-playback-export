# Xbox Playback Export

A small, local-first agent skill for exporting your Xbox Playback presentation
as a **1920x1080 H.264/AAC MP4**, without playback controls. It renders original
site overlays, fonts, video assets, and chapter music in a fresh muted headless
browser. No hosted service, GUI, account login automation, or telemetry.

## Status

**Experimental pre-release.** The agent acquires your presentation with browser
consent, renders it locally, and delivers the MP4. No manual JSON/DevTools step
is needed in the normal flow. One November 2026 site build is fingerprint-pinned.
Automated acquisition/download is verified on a synthetic browser page, not a
fresh signed-in live site. Different builds fail closed.

## Install

GitHub is the canonical source and release channel. These are **self-hosted
repository distributions**, not accepted listings in any official directory.
The root `plugin.json` uses Agent Plugins 1.0 for compatible Copilot/OpenAI hosts;
`.claude-plugin/` is a separate thin Claude wrapper. They all load the same
`skills/xbox-playback-export/SKILL.md` and Node scripts.

### GitHub Copilot CLI

```sh
copilot plugin install svanvliet/xbox-playback-export
```

Restart or open a session and ask it to export your Xbox Playback video. Older CLI
versions may need an update for Agent Plugins 1.0. Installation does not run npm
or grant local tool permissions; the skill walks through setup when used.

### Claude Code

```sh
claude plugin marketplace add svanvliet/xbox-playback-export
claude plugin install xbox-playback-export@svanvliet-playback
```

Invoke `/xbox-playback-export:xbox-playback-export` or ask for an Xbox Playback
export. For a single session from a clone: `claude --plugin-dir .`.

### Codex and ChatGPT

For local Codex, invoke its built-in skill installer with:

```text
$skill-installer install https://github.com/svanvliet/xbox-playback-export/tree/main/skills/xbox-playback-export
```

For compatible local ChatGPT desktop/Codex plugin hosts:

```sh
codex plugin marketplace add svanvliet/xbox-playback-export
```

Then restart the desktop app, select **svanvliet-playback** in its Plugins
Directory, and install the plugin. The repo includes the local marketplace
catalog at `.agents/plugins/marketplace.json`.

**A skill is not a local execution bridge.** ChatGPT web/mobile cannot run this
local browser/FFmpeg workflow without separately authorized local execution.
This release supplies no MCP server or tunnel and claims no tested web/mobile
export support. Local host packaging follows official formats; an installed-host
end-to-end agent run is not yet verified.

### Run directly (macOS or Windows)

Install Node 22.16+ (24 recommended), Edge or Chrome, and FFmpeg/ffprobe on PATH.
See [prerequisites and Windows instructions](skills/xbox-playback-export/references/usage.md).

```sh
git clone https://github.com/svanvliet/xbox-playback-export.git
cd xbox-playback-export
npm ci --prefix skills/xbox-playback-export --ignore-scripts --no-audit --no-fund
node skills/xbox-playback-export/scripts/cli.mjs export --url "https://www.xbox.com/en-US/playback" --consent headed --output "/private/playback.mp4"
```

Choose a new output filename in an existing folder. PowerShell uses the same
commands; replace paths with quoted Windows paths. Use `--quality share` for a
smaller file or `--browser chrome` instead of installed Edge. No Playwright browser
download is required. URL mode requires prior browser consent; sign in directly
in its separate window. Export records in real time, then encodes.

## Export without managing JSON

Ask your agent to export your Xbox Playback. After permission, it prefers
supported computer-use on your selected loaded tab, then supported browser tools.
When those capabilities are absent, it can open a separate muted Playwright
browser where **you** sign in and load Playback:

```sh
node skills/xbox-playback-export/scripts/cli.mjs export --url "https://www.xbox.com/en-US/playback" --consent headed --output "/private/playback.mp4"
```

Use your official Playback page URL; the example is not a verified live entrypoint.
The flag records prior permission, not a way to bypass approval. The helper waits
up to ten minutes, extracts only allowlisted presentation data into memory, closes
its own browser, then renders silently. It never collects credentials or uses
your everyday browser profile. Denials and permission failures stop the workflow,
not trigger a workaround.

See [agent-assisted acquisition and tool handoff](skills/xbox-playback-export/references/acquisition.md).
An installed skill does not grant browser tools or local execution. If tools are
missing, the agent explains the limitation. `--input` remains an advanced/recovery
option, not a required user-managed JSON step.

## What the export does

Original cue handling removes console-only cues without cutting an already-cut
Origin MP4 twice. Interactive holds become three seconds; Music and Mobile_rotate
are excluded from video scenes. TopPerformer is omitted for absent/invalid
percentages or values over 50. The automatic final loop shows only background.
Intro and Origin chapter soundtracks follow the original switch timing; final
audio/video fades of 1.5/0.6 seconds are export choices.

The CLI rejects unsupported builds, missing fonts/media, interactive controls,
bad timing markers, and duration drift. It verifies the final video/audio streams
before exclusive output publication. It never overwrites an existing file.
Downloads and recordings are temporary and cleaned on normal cancellation/errors.

## Development and evidence

```sh
npm ci --prefix skills/xbox-playback-export --ignore-scripts --no-audit --no-fund
npm test
claude plugin validate .
```

Synthetic tests cover input/asset boundaries, scene selection, marker parsing,
cancelled processes, safe output, allowlisted acquisition, real headless synthetic
page/Blob download, and actual FFmpeg encoding. Tests require installed Edge
(`PLAYBACK_TEST_BROWSER=chrome` selects installed Chrome). Windows/macOS/Linux
fixture CI is not live-account acquisition or rendering evidence.
English macOS/Edge is the real-fixture validation target; Windows real-account
exports and installed-host integration remain experimental.

A full imported-payload export has been verified on macOS/Edge: 1920x1080,
25 fps H.264/AAC with original overlays and chapter soundtracks. Personal input,
frames, and the resulting video are kept out of this repository and its releases.

## Privacy and project boundaries

- Sign in directly to Xbox; never provide account passwords or tokens to this project.
- Process personalized playback data locally.
- Do not commit personalized payloads, browser profiles, recordings, or diagnostics.
- Xbox application bundles, fonts, images, and music are not distributed here.
- Downloading public assets does not grant redistribution rights.
- Asset servers still receive ordinary public-media requests; local-first does
  not mean offline or anonymous.
- MIT applies only to original project code/documentation, not Xbox resources.
  Respect applicable terms and rights before using or sharing exported media.

This is an independent, unofficial project, not affiliated with or endorsed by
Microsoft/Xbox, OpenAI, Anthropic, or GitHub.

Packaging references: [Copilot plugins](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/plugins-creating),
[Claude distribution](https://code.claude.com/docs/en/plugins/publish),
[OpenAI skills](https://learn.chatgpt.com/docs/build-skills),
[OpenAI plugins](https://developers.openai.com/plugins/build/plugins).
