import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hosts = new Set(['www.xbox.com', 'assets-xbxweb.xbox.com', 'store-images.s-microsoft.com',
  'images-eds-ssl.xboxlive.com', 'cms-assets.xboxservices.com']);

export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid asset URL in presentation.'); }
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) {
    throw new Error('Asset URL is outside the supported HTTPS Xbox asset hosts.');
  }
  return url;
}

export class AssetCache {
  constructor(dir, { signal, fetchImpl = fetch, maxAssetBytes = 256 * 1024 * 1024,
    maxTotalBytes = 2 * 1024 * 1024 * 1024, maxRequests = 256 } = {}) {
    this.dir = dir;
    this.signal = signal;
    this.fetch = fetchImpl;
    this.maxAssetBytes = maxAssetBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.maxRequests = maxRequests;
    this.totalBytes = 0;
    this.requests = 0;
    this.entries = new Map();
  }

  async get(value) {
    validateUrl(value);
    this.signal?.throwIfAborted();
    if (!this.entries.has(value)) {
      const pending = this.download(value);
      this.entries.set(value, pending);
    }
    return this.entries.get(value);
  }

  async download(value) {
    let url = validateUrl(value);
    const timeout = AbortSignal.timeout(60000);
    const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      if (++this.requests > this.maxRequests) throw new Error('Asset request limit exceeded.');
      let response;
      try { response = await this.fetch(url, { signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' }); }
      catch { throw new Error(signal.aborted ? 'Asset download cancelled or timed out.' : 'Asset download failed.'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        if (redirects === 3) throw new Error('Asset redirect limit exceeded.');
        const location = response.headers.get('location');
        if (!location) throw new Error('Asset redirect has no destination.');
        url = validateUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Asset download failed (HTTP ${response.status}).`);
      }
      const type = (response.headers.get('content-type') ?? '').split(';')[0];
      if (!/^(image\/|video\/|audio\/|font\/|text\/css$|text\/javascript$|application\/(javascript|x-javascript|octet-stream|font-woff))/.test(type)) {
        await response.body.cancel();
        throw new Error('Unsupported asset content type.');
      }
      const file = path.join(this.dir, createHash('sha256').update(value).digest('hex'));
      const handle = await fs.open(file, 'wx', 0o600);
      let bytes = 0;
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          bytes += chunk.length;
          this.totalBytes += chunk.length;
          if (bytes > this.maxAssetBytes || this.totalBytes > this.maxTotalBytes) {
            throw new Error('Asset download size limit exceeded.');
          }
          await handle.writeFile(chunk);
        }
      } catch {
        throw new Error(signal.aborted ? 'Asset download cancelled or timed out.' : 'Asset download failed or exceeded its size limit.');
      } finally { await handle.close(); }
      if (!bytes) throw new Error('Empty asset download.');
      return { file, type };
    }
    throw new Error('Asset redirect limit exceeded.');
  }
}
