import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { validatePayload, selectScenes, readPayload } from '../skills/xbox-playback-export/scripts/payload.mjs';
import { AssetCache, validateUrl } from '../skills/xbox-playback-export/scripts/assets.mjs';
import { parseMarkers, audioTiming } from '../skills/xbox-playback-export/scripts/encode.mjs';
import { markerColors } from '../skills/xbox-playback-export/scripts/record.mjs';
import { parseArgs, publishFile } from '../skills/xbox-playback-export/scripts/cli.mjs';
import { verifyDigest, replaceOnce, patchRoute } from '../skills/xbox-playback-export/scripts/adapter.mjs';
import { run } from '../skills/xbox-playback-export/scripts/process.mjs';

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

test('manual acquisition reads only the bounded presentation prop and selected roots', async () => {
  const source = await fs.readFile(new URL('../skills/xbox-playback-export/references/acquire.js', import.meta.url), 'utf8');
  const payload = { ...fixture(), playbackMusicUri: uri, privateExtra: 'DO NOT SERIALIZE' };
  let blob;
  let clicked = false;
  const main = { '__reactFiber$synthetic': { return: { memoizedProps: { payload } } } };
  const context = {
    document: {
      scripts: [{ src: 'https://assets-xbxweb.xbox.com/xbox-web/static/js/PlaybackVideoPage.5cadca40.chunk.js' }],
      querySelector: () => main,
      createElement: () => ({ click: () => { clicked = true; }, remove() {} }),
      body: { appendChild() {} },
    },
    URL: { createObjectURL: value => { blob = value; return 'blob:synthetic'; }, revokeObjectURL() {} },
    Blob, setTimeout: fn => fn(),
  };
  vm.runInNewContext(source, context);
  assert.ok(clicked);
  const exported = JSON.parse(await blob.text());
  assert.equal(exported.userInformation.gamerTag, 'SYNTHETIC');
  assert.equal(exported.privateExtra, undefined);
  main.__reactFiber$synthetic = { return: null };
  assert.throws(() => vm.runInNewContext(source, context), /presentation payload/);
});
