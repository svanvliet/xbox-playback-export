import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { validatePayload } from './payload.mjs';

export const extractionSource = await fs.readFile(new URL('../references/acquire.js', import.meta.url), 'utf8');
export const playbackUrl = 'https://www.xbox.com/xboxplayback';

// The caller must supply a consented, confirmed default-profile context.
export async function preparePlaybackPage(context, { preferredPage, signal, timeoutMs = 30000 } = {}) {
  signal?.throwIfAborted();
  const pages = context.pages();
  if (preferredPage && !pages.includes(preferredPage)) {
    throw new Error('The selected tab does not belong to the approved browser context.');
  }
  const ordered = preferredPage ? [preferredPage, ...pages.filter(page => page !== preferredPage)] : pages;
  for (const page of ordered) {
    const value = page.url();
    try { validatePageUrl(value); } catch { continue; }
    return page;
  }
  let destination = playbackUrl;
  for (const page of ordered) {
    const value = page.url();
    let url;
    try { url = officialXboxUrl(value); } catch { continue; }
    const locale = url.pathname.match(/^\/([a-z]{2,3}(?:-[a-z]{4})?-(?:[a-z]{2}|\d{3}))(?:\/|$)/i)?.[1];
    if (locale) { destination = `${url.origin}/${locale}/xboxplayback`; break; }
  }
  const page = await context.newPage();
  signal?.throwIfAborted();
  try {
    await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch {
    throw new Error('Playback navigation failed; no alternate browser was opened. The new tab was left open.');
  }
  signal?.throwIfAborted();
  return page;
}

function parsePresentation(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) {
    throw new Error('Unsupported acquired presentation size.');
  }
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error('Cannot parse acquired presentation.'); }
  return validatePayload(payload);
}

// For browser tools that provide a Playwright Page and local module execution.
// The caller chooses an agent-owned private job directory, not the user's Downloads.
export async function savePresentationFromPage(page, destination, { signal, timeoutMs = 30000 } = {}) {
  signal?.throwIfAborted();
  validatePageUrl(page.url());
  let download;
  let handle;
  let stream;
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  void aborted.catch(() => {});
  const abort = () => {
    stream?.destroy();
    void download?.cancel().catch(() => {});
    rejectAbort(new Error(signal?.aborted ? 'Acquisition cancelled.' : 'Presentation download timed out.'));
  };
  combined.addEventListener('abort', abort, { once: true });
  let resolveDownload;
  const downloading = new Promise(resolve => { resolveDownload = resolve; });
  const onDownload = item => { download = item; resolveDownload(item); };
  page.once('download', onDownload);
  try {
    combined.throwIfAborted();
    handle = await fs.open(destination, 'wx', 0o600);
    await Promise.race([aborted, (async () => {
      await page.evaluate(`(${extractionSource})({download:true})`);
      await downloading;
    })()]);
    combined.throwIfAborted();
    stream = await Promise.race([aborted, download.createReadStream()]);
    if (!stream) throw new Error('Presentation download did not complete.');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of stream) {
      combined.throwIfAborted();
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error('Unsupported acquired presentation size.');
      chunks.push(chunk);
    }
    parsePresentation(Buffer.concat(chunks).toString('utf8'));
    combined.throwIfAborted();
    await handle.writeFile(Buffer.concat(chunks));
    await handle.sync();
    combined.throwIfAborted();
  } catch (error) {
    if (handle) {
      await handle.close();
      handle = undefined;
      await fs.unlink(destination);
    }
    if (error.code === 'EEXIST') throw new Error('Acquisition output already exists; choose a new private filename.');
    throw new Error('Presentation download failed, was cancelled, or was unsupported. No alternate browser was opened.');
  } finally {
    combined.removeEventListener('abort', abort);
    stream?.destroy();
    page.off('download', onDownload);
    await handle?.close();
    if (download) {
      try {
        await Promise.race([download.delete(), delay(5000, undefined, { ref: false }).then(() => {
          throw new Error('Download cleanup timed out.');
        })]);
      } catch { throw new Error('Cannot remove the owned browser download; clean that specific download before continuing.'); }
    }
  }
}

function officialXboxUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Not an official HTTPS Xbox page URL.'); }
  if (url.origin !== 'https://www.xbox.com' || url.username || url.password) {
    throw new Error('Not an official HTTPS Xbox page URL.');
  }
  return url;
}

export function validatePageUrl(value) {
  const url = officialXboxUrl(value);
  if (!/^\/(?:[a-z]{2,3}(?:-[a-z]{4})?-(?:[a-z]{2}|\d{3})\/)?xboxplayback(?:\/|$)/i.test(url.pathname)) {
    throw new Error('Not an Xbox Playback video route: expected /xboxplayback, not the /playback archive.');
  }
  return url.href;
}

export async function acquireFromPage(page, { signal, timeoutMs = 600000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new Error(signal?.aborted ?
    'Acquisition cancelled.' : 'Acquisition timed out waiting for sign-in, the /xboxplayback video route, or presentation readiness; this does not establish a build change.'));
  combined.addEventListener('abort', abort, { once: true });
  try {
    combined.throwIfAborted();
    return await Promise.race([aborted, (async () => {
      for (;;) {
        combined.throwIfAborted();
        // Login/MFA belongs to the user. Do not inspect other page contents.
        let isPlayback = false;
        try { validatePageUrl(page.url()); isPlayback = true; } catch {
          let url;
          try { url = officialXboxUrl(page.url()); } catch { /* Login/MFA can leave the Xbox origin. */ }
          if (url && /^\/(?:[a-z]{2,3}(?:-[a-z]{4})?-(?:[a-z]{2}|\d{3})\/)?playback(?:\/|$)/i.test(url.pathname)) {
            throw new Error('The /playback archive is not the Xbox Playback video experience; navigate to /xboxplayback.');
          }
        }
        if (isPlayback) {
          let text;
          try { text = await page.evaluate(`(${extractionSource})()`); }
          catch (error) {
            if (!/^page\.evaluate: (?:Error: )?PLAYBACK_(?:ROUTE_)?NOT_READY(?:\n|$)/.test(error.message)) {
              const code = error.message.match(/(?:^|\n)(?:page\.evaluate: )?(?:Error: )?(PLAYBACK_[A-Z_]+)(?:\n|$)/)?.[1];
              throw new Error(code === 'PLAYBACK_UNSUPPORTED_BUILD' ? 'Unsupported Xbox acquisition build; stopped without inspecting other state.' :
                code === 'PLAYBACK_INVALID_DATA' ? 'Unsupported presentation data; acquisition stopped.' :
                  code === 'PLAYBACK_WRONG_PAGE' ? 'The selected tab left the official /xboxplayback video route; acquisition stopped.' :
                  'Browser acquisition failed or the selected tab closed; no alternate browser was opened.');
            }
          }
          if (text !== undefined) {
            return parsePresentation(text);
          }
        }
        await delay(250, undefined, { signal: combined });
      }
    })()]);
  } finally { combined.removeEventListener('abort', abort); }
}
