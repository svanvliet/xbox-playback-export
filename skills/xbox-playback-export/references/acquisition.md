# Importing your presentation

The MVP accepts **local presentation JSON**, not account credentials. There is no
automatic network/API acquisition, sign-in tool, or local bridge server.

The supported renderer is pinned to route
`PlaybackVideoPage.5cadca40.chunk.js` and client `client.ce0773f6.js`.
The helper verifies SHA-256 for all nine JavaScript bundles and five stylesheets
at runtime; a changed or unavailable build fails closed.

## Manual acquisition (your own account, your own browser)

1. Open Xbox Playback on the official Xbox website, sign in directly there, and
   load your personalized presentation. Neither this project nor your agent needs
   your password, cookies, or tokens.
2. Review the short [acquire.js](acquire.js) file. It checks the route script's
   version and finds `main[data-experience-completed]`, then follows **at most 64
   React Fiber ancestors** looking only at `memoizedProps.payload`. It serializes
   six presentation roots, not the application store, network traffic, or browser
   session.
3. If you choose to proceed, run that reviewed script yourself in that tab's
   DevTools Console. It downloads `xbox-playback-scenes.json`. Do not bypass browser
   security warnings or run scripts you do not understand. An agent must ask and
   wait before interacting with this tab or other visible browser UI.
4. Move the JSON into a private local folder outside source control. Pass its path
   to `validate` and then `export`. Do not paste the JSON into public chats,
   issues, logs, or repositories.

The Fiber/prop path was used successfully in the original local proof. This
packaged acquisition script is tested with a **synthetic Fiber tree**, not a
fresh signed-in browser; browser DOM and availability may differ. If it says
unsupported or cannot find the payload, stop. Do not broaden the traversal to
other state, capture cookies, or dump network responses. An already-exported
presentation JSON remains a supported input.

## Supported shape and boundaries

The presentation has `chapterCount`, `chapters`, `commonText`, `userInformation`,
`playbackMusicUri`, and `chapterCues`. Chapters are, in order, `Intro`, `Origin`,
and `Outro`, each with `data.videoSequence`. Scenes contain `kind`,
`backgroundVideoUri`, `loopingVideo`, and `requiresUserInteraction`. Each chapter
retains its original localized text and data; `userInformation` contains
`gamerTag` and `gamerPicUri`. Do not invent missing presentation values.

This release uses the original renderer's **en-US presentation provider** and is
validated only with an English presentation. It does not translate data.
Different chapter variants/locales are unverified and may fail preflight.

All imported data is private. It can contain your gamertag, gamer picture URL,
games, achievements, dates, and play history. The renderer downloads public media
to a new private temporary directory on your computer, without account cookies
or auth headers. Rendering sends media requests to an explicit Xbox/Microsoft
asset-host allowlist, so those hosts can observe ordinary asset downloads.
This is local-first, not offline or network-anonymous.

No sample account payload is distributed. Tests generate synthetic structures.
