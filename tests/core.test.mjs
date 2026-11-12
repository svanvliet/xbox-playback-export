import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { validatePayload, selectScenes, readPayload } from '../skills/xbox-playback-export/scripts/payload.mjs';
import { AssetCache, validateUrl } from '../skills/xbox-playback-export/scripts/assets.mjs';
import { parseMarkers, audioTiming } from '../skills/xbox-playback-export/scripts/encode.mjs';
import { markerColors } from '../skills/xbox-playback-export/scripts/record.mjs';
import { main, parseArgs, publishFile } from '../skills/xbox-playback-export/scripts/cli.mjs';
import { verifyDigest, replaceOnce, patchRoute } from '../skills/xbox-playback-export/scripts/adapter.mjs';
import { run } from '../skills/xbox-playback-export/scripts/process.mjs';
import { extractionSource, acquireFromPage, savePresentationFromPage, validatePageUrl, preparePlaybackPage, playbackUrl } from '../skills/xbox-playback-export/scripts/acquire.mjs';

const uri = 'https://assets-xbxweb.xbox.com/synthetic.mp4';
export function fixture() {
  const scene = kind => ({ kind, backgroundVideoUri: uri, loopingVideo: ['Looping', 'Music'].includes(kind), requiresUserInteraction: false });
  return {
    chapterCount: 3, chapterCues: [], commonText: { gamerscoreText: 'Score' },
    userInformation: { gamerTag: 'SYNTHETIC', gamerPicUri: 'https://images-eds-ssl.xboxlive.com/synthetic.png' },
    chapters: [
      { kind: 'Intro', data: { videoSequence: ['Intro', 'Looping', 'Music', 'Mobile_rotate'].map(scene) } },
      { kind: 'Origin', data: { topPercentage: 10, videoSequence: ['Origin', 'TopPerformer', 'Music'].map(scene) } },
      { kind: 'Outro', data: { videoSequence: ['Outro', 'Looping'].map(scene) } },
    ],
  };
}

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playback-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('scene selection skips music/mobile and rejects absent or invalid TopPerformer percentages', () => {
  assert.equal(selectScenes(validatePayload(fixture())).length, 6);
  for (const value of [undefined, null, NaN, Infinity, '10', 0, -1, 50.1, 100]) {
    const payload = fixture();
    payload.chapters[1].data.topPercentage = value;
    assert.equal(selectScenes(payload).length, 5);
  }
  const payload = fixture();
  payload.chapters[1].data.topPercentage = 50;
  assert.equal(selectScenes(payload).filter(s => s.kind === 'TopPerformer').length, 1);
});

test('payload rejects unsupported scenes, duplicate scenes, prototype keys, malformed roots and URLs', () => {
  for (const mutate of [
    p => { p.chapters[0].data.videoSequence[0].kind = 'Future'; },
    p => { p.chapters[1].data.videoSequence.push(p.chapters[1].data.videoSequence[0]); },
    p => { p.chapters.reverse(); },
    p => { p.userInformation = null; },
    p => { p.chapters[0].data.videoSequence[0].backgroundVideoUri = 'file:///private/secret'; },
    p => { p.chapters[0].data.videoSequence[0].loopingVideo = true; },
    p => { p.commonText.extra = JSON.parse('{"__proto__":{}}'); },
  ]) {
    const payload = fixture();
    mutate(payload);
    assert.throws(() => validatePayload(payload));
  }
});

test('input errors never echo personalized JSON contents', async t => {
  const dir = await temporary(t);
  const file = path.join(dir, 'private.json');
  await fs.writeFile(file, '{"PRIVATE SENTINEL":');
  await assert.rejects(readPayload(file), error => !error.message.includes('PRIVATE SENTINEL'));
  await fs.writeFile(file, ' '.repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(readPayload(file), /exceeds/);
});

test('URL allowlist rejects credentials, alternate ports, local hosts and deceptive suffixes', () => {
  for (const value of ['http://www.xbox.com/a', 'https://localhost/a', 'https://www.xbox.com.evil.invalid/a',
    'https://name:secret@www.xbox.com/a', 'https://www.xbox.com:8443/a', 'data:image/png;base64,abc']) {
    assert.throws(() => validateUrl(value));
  }
  assert.equal(validateUrl(uri).hostname, 'assets-xbxweb.xbox.com');
});

test('asset cache rejects unsafe redirects before fetching them and bounds requests', async t => {
  const dir = await temporary(t);
  let requests = 0;
  const cache = new AssetCache(dir, { fetchImpl: async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  } });
  await assert.rejects(cache.get(uri), /outside/);
  assert.equal(requests, 1);
  const repeated = new AssetCache(dir, { maxRequests: 2, fetchImpl: async () =>
    new Response(null, { status: 302, headers: { location: uri } }) });
  await assert.rejects(repeated.get(uri), /request limit/);
});

test('asset cache handles redirect MIME and size limits without logging URLs', async t => {
  const dir = await temporary(t);
  const oversized = new AssetCache(dir, { maxAssetBytes: 2, fetchImpl: async () =>
    new Response('123', { headers: { 'content-type': 'image/png' } }) });
  await assert.rejects(oversized.get(`${uri}?PRIVATE=SENTINEL`), error =>
    /size limit/.test(error.message) && !error.message.includes('SENTINEL'));
  const html = new AssetCache(dir, { fetchImpl: async () => new Response('page', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(html.get(uri), /content type/);
});

test('asset cache deduplicates concurrent requests and passes no credentials', async t => {
  const dir = await temporary(t);
  let requests = 0;
  const cache = new AssetCache(dir, { fetchImpl: async (_, options) => {
    requests++;
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual');
    return new Response('image', { headers: { 'content-type': 'image/png' } });
  } });
  const [a, b] = await Promise.all([cache.get(uri), cache.get(uri)]);
  assert.equal(a.file, b.file);
  assert.equal(await fs.readFile(a.file, 'utf8'), 'image');
  assert.equal(requests, 1);
});

test('asset cache bounds total bytes and respects cancellation', async t => {
  const dir = await temporary(t);
  const controller = new AbortController();
  const cache = new AssetCache(dir, { maxTotalBytes: 5, signal: controller.signal,
    fetchImpl: async () => new Response('123', { headers: { 'content-type': 'image/png' } }) });
  await cache.get(`${uri}?asset=1`);
  await assert.rejects(cache.get(`${uri}?asset=2`), /size limit/);
  controller.abort();
  await assert.rejects(cache.get(`${uri}?asset=3`), { name: 'AbortError' });
});

const pixelsFor = labels => Buffer.from(labels.flatMap(label => label === -1 ? [80, 80, 80] : markerColors[label]));
test('markers derive five or six scenes, tolerate bounded compression noise, and reject missing/reordered scenes', () => {
  for (const count of [5, 6]) {
    const labels = [...Array(10).fill(0)];
    for (let i = 1; i <= count; i++) labels.push(...Array(30).fill(i), -1, -1, ...Array(5).fill(i));
    labels.push(...Array(10).fill(0));
    const frames = parseMarkers(pixelsFor(labels), count);
    assert.equal(frames.length, count);
    assert.equal(frames[0].start, 10);
    assert.equal(frames.at(-1).end, labels.length - 10);
    const scenes = ['Intro', 'Intro', 'Origin', 'Origin', 'Outro', 'Outro'].slice(0, count).map(chapter => ({ chapter }));
    assert.equal(audioTiming(frames, scenes, 25).originStart, 74 / 25);
  }
  for (const labels of [
    [...Array(10).fill(0), ...Array(20).fill(1)],
    [...Array(10).fill(0), ...Array(20).fill(2), ...Array(20).fill(1), ...Array(10).fill(0)],
    [...Array(10).fill(0), ...Array(20).fill(1), ...Array(13).fill(-1), ...Array(20).fill(2), ...Array(10).fill(0)],
  ]) assert.throws(() => parseMarkers(pixelsFor(labels), 2));
});

test('adapter fails closed when bundle fingerprints or patch signatures change', () => {
  assert.throws(() => verifyDigest('future bundle', '0'.repeat(64)), /fingerprint/);
  assert.throws(() => replaceOnce('same same', 'same', 'other'), /structure/);
  assert.throws(() => patchRoute('var futureBuild = true;'), /route module/);
});

test('argument handling accepts spaced paths and rejects overwrite/unsupported options', () => {
  assert.equal(parseArgs(['export', '--input', 'a b.json', '--output', 'c d.mp4']).output, 'c d.mp4');
  for (const args of [
    ['export', '--input', 'a.json'], ['validate', '--input', 'a', '--input', 'b'],
    ['export', '--input', 'a', '--output', 'b.gif'], ['validate', '--input'],
    ['export', '--input', 'a', '--output', 'b.mp4', '--browser', 'safari'],
    ['export', '--input', 'a', '--output', 'b.mp4', '--force', 'yes'],
  ]) assert.throws(() => parseArgs(args));
});

test('output publishing is exclusive and handles spaced paths', async t => {
  const dir = await temporary(t);
  const source = path.join(dir, 'source file.mp4');
  const destination = path.join(dir, 'destination file.mp4');
  await fs.writeFile(source, 'synthetic data');
  await publishFile(source, destination);
  assert.equal(await fs.readFile(destination, 'utf8'), 'synthetic data');
  await assert.rejects(publishFile(source, destination), { code: 'EEXIST' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'synthetic data');
  const partial = path.join(dir, 'partial.mp4');
  await assert.rejects(publishFile(path.join(dir, 'missing source'), partial));
  await assert.rejects(fs.stat(partial), { code: 'ENOENT' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(publishFile(source, partial, controller.signal), { name: 'AbortError' });
  await assert.rejects(fs.stat(partial), { code: 'ENOENT' });
});

test('cancelled child exits and does not leave a background command running', async () => {
  const controller = new AbortController();
  const result = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(result, /cancelled/);
});

test('acquisition allowlists every nested field and never invokes extra auth getters or serializers', () => {
  const payload = { ...fixture(), playbackMusicUri: uri, accessToken: 'PRIVATE_SENTINEL' };
  payload.userInformation.cookies = 'PRIVATE_SENTINEL';
  payload.chapters[1].data.refreshToken = 'PRIVATE_SENTINEL';
  payload.chapters[0].data.videoSequence[0].authorization = 'PRIVATE_SENTINEL';
  payload.commonText.toJSON = () => { throw Error('Must not execute serializers'); };
  Object.defineProperty(payload.userInformation, 'authState', { get() { throw Error('Must not read auth state'); } });
  const main = { '__reactFiber$synthetic': { return: { memoizedProps: { payload } } } };
  const context = {
    location: { href: 'https://www.xbox.com/en-US/playback/video' },
    document: {
      scripts: [{ src: 'https://assets-xbxweb.xbox.com/xbox-web/static/js/PlaybackVideoPage.5cadca40.chunk.js' }],
      querySelector: () => main,
    },
    URL, TextEncoder,
  };
  const extract = () => vm.runInNewContext(`(${extractionSource})()`, context);
  const text = extract();
  const exported = JSON.parse(text);
  context.location.href = 'https://www.xbox.com/en-US/xboxplayback';
  assert.deepEqual(JSON.parse(extract()), exported);
  assert.deepEqual(Object.keys(exported).sort(), ['chapterCount', 'chapters', 'commonText', 'userInformation', 'chapterCues'].sort());
  assert.equal(exported.userInformation.gamerTag, 'SYNTHETIC');
  assert.ok(!text.includes('PRIVATE_SENTINEL'));
  validatePayload(exported);
  context.location.href = 'https://www.xbox.com.evil.invalid/en-US/playback';
  assert.throws(extract, /WRONG_PAGE/);
  context.location.href = 'https://www.xbox.com/en-US/account';
  assert.throws(extract, /WRONG_PAGE/);
  context.location.href = 'https://www.xbox.com/en-US/playback';
  context.document.scripts = [];
  assert.throws(extract, /UNSUPPORTED_BUILD/);
  context.document.scripts = [{ src: 'https://assets-xbxweb.xbox.com/xbox-web/static/js/PlaybackVideoPage.5cadca40.chunk.js' }];
  main.__reactFiber$synthetic = { return: null };
  assert.throws(extract, /NOT_READY/);
  const cycle = { return: null };
  cycle.return = cycle;
  main.__reactFiber$synthetic = cycle;
  assert.throws(extract, /NOT_READY/);
  main.__reactFiber$synthetic = { memoizedProps: { payload } };
  payload.userInformation.gamerTag = { accessToken: 'PRIVATE_SENTINEL' };
  assert.throws(extract, /INVALID_DATA/);
  Object.defineProperty(payload.userInformation, 'gamerTag', { get() { throw Error('PRIVATE_SENTINEL'); } });
  assert.throws(extract, /INVALID_DATA/);
  Object.defineProperty(payload.userInformation, 'gamerTag', { value: 'SYNTHETIC' });
  payload.commonText.additionalTextStrings = Array.from({ length: 18 }, () => ({ kind: 'text', text: '\u00e9'.repeat(60000) }));
  assert.throws(extract, /INVALID_DATA/);
});

test('Edge remains the default renderer and legacy URL acquisition cannot open a separate profile', async () => {
  for (const url of ['http://www.xbox.com/en-US/playback', 'https://xbox.com/en-US/playback',
    'https://www.xbox.com:8443/playback', 'https://name:secret@www.xbox.com/playback',
    'https://www.xbox.com/en-US/playback-fake', 'https://evil.invalid/playback',
    'https://www.xbox.com/en-US/xboxplayback-fake', 'https://www.xbox.com.evil.invalid/xboxplayback']) {
    assert.throws(() => validatePageUrl(url));
  }
  assert.equal(parseArgs(['export', '--input', 'a.json', '--output', 'a.mp4']).browser, 'msedge');
  await assert.rejects(main(['export', '--url', 'https://www.xbox.com/en-US/playback', '--consent', 'headed', '--output', 'a.mp4']),
    /existing Edge default-profile tab/);
  for (const options of [
    ['--url', 'https://www.xbox.com/en-US/playback'],
    ['--url', 'https://www.xbox.com/en-US/playback', '--consent', 'yes'],
    ['--input', 'a.json', '--consent', 'headed'],
    ['--input', 'a.json', '--url', 'https://www.xbox.com/playback', '--consent', 'headed'],
  ]) assert.throws(() => parseArgs(['export', '--output', 'a.mp4', ...options]), /no longer opens a separate profile/);
});

test('Playback navigation cancellation and refusal never create a fallback or replace existing tabs', async () => {
  let opened = 0;
  const context = {
    pages: () => [{ url: () => 'https://example.invalid/unsaved' }],
    newPage: async () => { opened++; return { goto: async () => { throw Error('Native permission denied PRIVATE_SENTINEL'); } }; },
  };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(preparePlaybackPage(context, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(opened, 0);
  await assert.rejects(preparePlaybackPage(context), /^Error: Playback navigation failed;/);
  assert.equal(opened, 1);
});

test('acquisition stops on refusal/unsupported pages, bounds waiting, and never opens a fallback browser', async () => {
  let evaluations = 0;
  for (const message of ['page.evaluate: Error: PLAYBACK_UNSUPPORTED_BUILD', 'Native permission denied PRIVATE_SENTINEL',
    'page.evaluate: Error: PLAYBACK_INVALID_DATA', 'Target page closed']) {
    const page = { url: () => 'https://www.xbox.com/playback', evaluate: async () => { evaluations++; throw Error(message); } };
    const before = evaluations;
    await assert.rejects(acquireFromPage(page), error => !error.message.includes('PRIVATE_SENTINEL'));
    assert.equal(evaluations, before + 1);
  }
  const page = { url: () => 'https://www.xbox.com/playback', evaluate: async () => { throw Error('page.evaluate: Error: PLAYBACK_NOT_READY'); } };
  await assert.rejects(acquireFromPage(page, { timeoutMs: 30 }), /timed out/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(acquireFromPage(page, { signal: controller.signal }), /cancelled/);
});

test('download timeout and mid-flight cancellation remove owned files/listeners without closing user tabs', async t => {
  const dir = await temporary(t);
  for (const cancel of [false, true]) {
    const page = new EventEmitter();
    page.url = () => 'https://www.xbox.com/en-US/playback';
    page.evaluate = () => new Promise(() => {});
    page.close = () => { throw Error('Must not close a host-owned tab'); };
    const controller = new AbortController();
    const destination = path.join(dir, cancel ? 'cancelled.json' : 'timeout.json');
    const result = savePresentationFromPage(page, destination, { timeoutMs: cancel ? 1000 : 30, signal: controller.signal });
    if (cancel) setTimeout(() => controller.abort(), 20);
    await assert.rejects(result, /failed/);
    await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
    assert.equal(page.listenerCount('download'), 0);
  }
});

test('real browser opens missing Playback tab, reuses it, acquires synthetic data and completes a private Blob download', async t => {
  const { chromium } = createRequire(new URL('../skills/xbox-playback-export/package.json', import.meta.url))('playwright');
  const browser = await chromium.launch({ channel: process.env.PLAYBACK_TEST_BROWSER || 'msedge',
    headless: true, args: ['--mute-audio'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', route => route.fulfill({ contentType: 'text/html',
    body: '<html><body><main data-experience-completed></main></body></html>' }));
  const unrelated = await context.newPage();
  await unrelated.goto('https://example.invalid/unsaved');
  const page = await preparePlaybackPage(context);
  assert.notEqual(page, unrelated);
  assert.equal(page.url(), playbackUrl);
  assert.equal(unrelated.url(), 'https://example.invalid/unsaved');
  assert.equal(context.pages().length, 2);
  assert.equal(await preparePlaybackPage(context), page);
  assert.equal(context.pages().length, 2);
  const payload = fixture();
  payload.accessToken = 'PRIVATE_SENTINEL';
  payload.userInformation.refreshToken = 'PRIVATE_SENTINEL';
  payload.chapters[1].data.topGamesData = [{ gameName: 'SYNTHETIC', auth: 'PRIVATE_SENTINEL' }];
  await page.evaluate(p => {
    const script = document.createElement('script');
    script.type = 'application/json';
    script.src = 'https://assets-xbxweb.xbox.com/xbox-web/static/js/PlaybackVideoPage.5cadca40.chunk.js';
    document.head.appendChild(script);
    document.querySelector('main').__reactFiber$synthetic = { return: { memoizedProps: { payload: p } } };
  }, payload);
  const acquired = await acquireFromPage(page, { timeoutMs: 5000 });
  assert.equal(acquired.userInformation.gamerTag, 'SYNTHETIC');
  assert.ok(!JSON.stringify(acquired).includes('PRIVATE_SENTINEL'));
  await page.evaluate(() => {
    const main = document.querySelector('main');
    const fiber = main.__reactFiber$synthetic;
    delete main.__reactFiber$synthetic;
    setTimeout(() => { main.__reactFiber$synthetic = fiber; }, 100);
  });
  assert.deepEqual(await acquireFromPage(page, { timeoutMs: 5000 }), acquired);
  const dir = await temporary(t);
  await fs.chmod(dir, 0o700);
  const destination = path.join(dir, 'agent presentation.json');
  await savePresentationFromPage(page, destination, { timeoutMs: 5000 });
  assert.deepEqual(await readPayload(destination), acquired);
  if (process.platform !== 'win32') assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  await assert.rejects(savePresentationFromPage(page, destination), /already exists/);
  assert.deepEqual(await readPayload(destination), acquired);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(savePresentationFromPage(page, path.join(dir, 'cancelled.json'), { signal: cancelled.signal }));
  await assert.rejects(fs.stat(path.join(dir, 'cancelled.json')), { code: 'ENOENT' });
  await page.evaluate(() => { delete document.querySelector('main').__reactFiber$synthetic; });
  const missing = path.join(dir, 'not ready.json');
  await assert.rejects(savePresentationFromPage(page, missing, { timeoutMs: 200 }), /failed/);
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  assert.equal(page.listenerCount('download'), 0);
  assert.ok(!page.isClosed());
});
