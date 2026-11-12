import fs from 'node:fs/promises';
import { validateUrl } from './assets.mjs';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowedScenes = {
  Intro: ['Intro', 'Looping', 'Music', 'Mobile_rotate'],
  Origin: ['Origin', 'TopPerformer', 'Music'],
  Outro: ['Outro', 'Looping'],
};

export function validatePayload(payload) {
  const fail = () => { throw new Error('Unsupported presentation JSON; see references/acquisition.md for the supported shape.'); };
  let count = 0;
  const walk = (value, depth = 0) => {
    if (++count > 20000 || depth > 24) fail();
    if (typeof value === 'string') {
      if (value.length > 100000) fail();
      if (/^https?:/i.test(value)) validateUrl(value);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail();
        walk(child, depth + 1);
      }
    }
  };
  walk(payload);
  if (!isObject(payload) || !isObject(payload.commonText) || !isObject(payload.userInformation) ||
      typeof payload.userInformation.gamerTag !== 'string' ||
      typeof payload.userInformation.gamerPicUri !== 'string' ||
      typeof payload.commonText.gamerscoreText !== 'string' ||
      !Array.isArray(payload.chapters) || payload.chapters.length !== 3 ||
      payload.chapters.map(c => c?.kind).join(',') !== 'Intro,Origin,Outro') fail();
  validateUrl(payload.userInformation.gamerPicUri);
  for (const chapter of payload.chapters) {
    const data = chapter.data;
    if (!isObject(data) || !Array.isArray(data.videoSequence)) fail();
    const seen = new Set();
    for (const scene of data.videoSequence) {
      if (!isObject(scene) || !allowedScenes[chapter.kind].includes(scene.kind) || seen.has(scene.kind) ||
          typeof scene.loopingVideo !== 'boolean' || typeof scene.requiresUserInteraction !== 'boolean') fail();
      validateUrl(scene.backgroundVideoUri);
      seen.add(scene.kind);
    }
    if (!seen.has(chapter.kind) ||
        (chapter.kind !== 'Outro' && !seen.has('Music')) ||
        (chapter.kind !== 'Origin' && !seen.has('Looping'))) fail();
    const renderOrder = data.videoSequence.filter(s => !['Music', 'Mobile_rotate', 'TopPerformer'].includes(s.kind));
    if (renderOrder.map(s => s.kind).join(',') !== (chapter.kind === 'Origin' ? 'Origin' : `${chapter.kind},Looping`)) fail();
    if (data.videoSequence.some(s => s.loopingVideo !== ['Looping', 'Music'].includes(s.kind))) fail();
  }
  return payload;
}

export async function readPayload(file) {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > 2 * 1024 * 1024) throw new Error('Presentation JSON exceeds 2 MiB.');
    let payload;
    try { payload = JSON.parse(await handle.readFile('utf8')); }
    catch { throw new Error('Cannot parse presentation JSON.'); }
    return validatePayload(payload);
  } finally { await handle.close(); }
}

export function selectScenes(payload) {
  return payload.chapters.flatMap(chapter => chapter.data.videoSequence
    .filter(scene => !['Music', 'Mobile_rotate'].includes(scene.kind))
    .filter(scene => scene.kind !== 'TopPerformer' ||
      (typeof chapter.data.topPercentage === 'number' && Number.isFinite(chapter.data.topPercentage) &&
       chapter.data.topPercentage > 0 && chapter.data.topPercentage <= 50))
    .map(scene => ({ chapter: chapter.kind, kind: scene.kind, uri: scene.backgroundVideoUri, looping: scene.loopingVideo })));
}
