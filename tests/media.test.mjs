import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { run, probe } from '../skills/xbox-playback-export/scripts/process.mjs';
import { encode } from '../skills/xbox-playback-export/scripts/encode.mjs';
import { markerColors } from '../skills/xbox-playback-export/scripts/record.mjs';

test('synthetic capture encodes five scenes to verified 1080p H264/AAC without timing band', { timeout: 120000 }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'playback-media-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const capture = path.join(dir, 'synthetic capture.mkv');
  const music = ['Intro', 'Origin'].map(kind => path.join(dir, `synthetic ${kind} music.wav`));
  const output = path.join(dir, 'synthetic output.mp4');
  const segments = [0, 1, 2, 3, 4, 5, 0];
  const sources = segments.map((color, i) => {
    const hex = markerColors[color].map(n => n.toString(16).padStart(2, '0')).join('');
    return `color=c=black:s=1920x1082:r=25:d=${i === 0 || i === 6 ? 0.4 : 1},` +
      `drawbox=x=0:y=1080:w=iw:h=2:color=0x${hex}:t=fill[s${i}]`;
  });
  const filter = `${sources.join(';')};${segments.map((_, i) => `[s${i}]`).join('')}concat=n=7:v=1:a=0`;
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', filter, '-map', '0:v:0',
    '-c:v', 'ffv1', capture]);
  for (const [i, file] of music.entries()) {
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${i ? 880 : 440}:duration=8`,
      '-c:a', 'pcm_s16le', file]);
  }
  const scenes = ['Intro', 'Intro', 'Origin', 'Outro', 'Outro'].map(chapter => ({ chapter, duration: 1 }));
  const payload = { chapters: ['Intro', 'Origin'].map(kind => ({
    kind, data: { videoSequence: [{ kind: 'Music', backgroundVideoUri: `https://assets-xbxweb.xbox.com/${kind}.wav` }] },
  })) };
  const cache = { get: async uri => ({ file: music[uri.endsWith('Intro.wav') ? 0 : 1] }) };
  const result = await encode(capture, scenes, payload, cache, output);
  assert.equal(result.sceneCount, 5);
  assert.equal(result.duration, 5);
  const info = await probe(output);
  assert.equal(info.streams.find(s => s.codec_type === 'video').height, 1080);
  assert.equal(info.format.tags.title, 'Xbox Playback');
  const audioSample = async time => {
    const data = await run('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', output,
      '-t', '0.2', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
    const samples = Array.from({ length: data.length / 2 }, (_, i) => data.readInt16LE(i * 2));
    const crossings = samples.reduce((n, sample, i) => n + (i > 0 && sample >= 0 && samples[i - 1] < 0 ? 1 : 0), 0);
    return { frequency: crossings / (samples.length / 8000),
      rms: Math.sqrt(samples.reduce((n, value) => n + value * value, 0) / samples.length) };
  };
  assert.ok(Math.abs((await audioSample(1.2)).frequency - 440) < 15);
  assert.ok(Math.abs((await audioSample(3.1)).frequency - 880) < 15);
  assert.ok((await audioSample(4.8)).rms < (await audioSample(3.1)).rms * 0.2);
  await assert.rejects(encode(capture, scenes, payload, cache, output), /Output already exists/);
});
