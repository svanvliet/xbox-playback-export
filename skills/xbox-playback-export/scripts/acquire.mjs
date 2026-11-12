import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { validatePayload } from './payload.mjs';

export const extractionSource = await fs.readFile(new URL('../references/acquire.js', import.meta.url), 'utf8');

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

export function validatePageUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Choose an official HTTPS Xbox Playback page URL.'); }
  if (url.origin !== 'https://www.xbox.com' || url.username || url.password ||
      !/^\/(?:[a-z]{2}-[a-z]{2}\/)?playback(?:\/|$)/i.test(url.pathname)) {
    throw new Error('Choose an official HTTPS Xbox Playback page URL.');
  }
  return url.href;
}

export async function acquireFromPage(page, { signal, timeoutMs = 600000 } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new Error(signal?.aborted ?
    'Acquisition cancelled.' : 'Acquisition timed out; no ready supported presentation was found.'));
  combined.addEventListener('abort', abort, { once: true });
  try {
    combined.throwIfAborted();
    return await Promise.race([aborted, (async () => {
      for (;;) {
        combined.throwIfAborted();
        // Login/MFA belongs to the user. Do not inspect other page contents.
        let isPlayback = false;
        try { validatePageUrl(page.url()); isPlayback = true; } catch { /* Wait for the selected Playback page. */ }
        if (isPlayback) {
          let text;
          try { text = await page.evaluate(`(${extractionSource})()`); }
          catch (error) {
            if (!/^page\.evaluate: (?:Error: )?PLAYBACK_NOT_READY(?:\n|$)/.test(error.message)) {
              const code = error.message.match(/(?:^|\n)(?:page\.evaluate: )?(?:Error: )?(PLAYBACK_[A-Z_]+)(?:\n|$)/)?.[1];
              throw new Error(code === 'PLAYBACK_UNSUPPORTED_BUILD' ? 'Unsupported Xbox acquisition build; stopped without inspecting other state.' :
                code === 'PLAYBACK_INVALID_DATA' ? 'Unsupported presentation data; acquisition stopped.' :
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
