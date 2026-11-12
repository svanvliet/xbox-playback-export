import fs from 'node:fs/promises';
import { run, probe } from './process.mjs';
import { markerColors } from './record.mjs';

export function parseMarkers(pixels, sceneCount) {
  if (!Number.isInteger(sceneCount) || sceneCount < 1 || sceneCount >= markerColors.length || pixels.length % 3) {
    throw new Error('Invalid capture marker input.');
  }
  const spans = [];
  for (let frame = 0; frame < pixels.length / 3; frame++) {
    let color = -1;
    let distance = 50;
    for (let i = 0; i < markerColors.length; i++) {
      const d = markerColors[i].reduce((sum, channel, c) => sum + Math.abs(channel - pixels[frame * 3 + c]), 0);
      if (d < distance) { distance = d; color = i; }
    }
    const last = spans.at(-1);
    if (last?.color === color) last.end = frame + 1;
    else spans.push({ color, start: frame, end: frame + 1 });
  }
  const leader = spans.find(s => s.color === 0 && s.end - s.start >= 5);
  const trailer = spans.at(-1);
  if (!leader || !trailer || trailer === leader || trailer.color !== 0 || trailer.end - trailer.start < 5) {
    throw new Error('Missing capture leader or trailer.');
  }
  const scenes = [];
  for (const span of spans.filter(s => s.start >= leader.end && s.end <= trailer.start)) {
    if (span.color < 0 && span.end - span.start <= 12) continue;
    const last = scenes.at(-1);
    if (last?.color === span.color) last.end = span.end;
    else scenes.push({ ...span });
  }
  if (scenes.length !== sceneCount || scenes.some((s, i) => s.color !== i + 1)) {
    throw new Error('Unexpected capture timing markers; refusing an incorrectly trimmed export.');
  }
  for (let i = 0; i < scenes.length - 1; i++) scenes[i].end = scenes[i + 1].start;
  return scenes;
}

export function audioTiming(sceneFrames, scenes, fps) {
  const start = sceneFrames[0].start;
  const duration = (sceneFrames.at(-1).end - start) / fps;
  const originIndex = scenes.findIndex(s => s.chapter === 'Origin');
  if (originIndex < 0 || !sceneFrames[originIndex]) throw new Error('Origin chapter is missing.');
  const originStart = (sceneFrames[originIndex].start - start) / fps;
  const switchAt = originStart + 0.5;
  const secondDuration = duration - switchAt;
  if (originStart < 1 || secondDuration < 1.5) throw new Error('Capture is too short for chapter audio transitions.');
  return { start, end: sceneFrames.at(-1).end, duration, originStart, switchAt, secondDuration };
}

export async function encode(capture, scenes, payload, cache, output, { signal, quality = 'high' } = {}) {
  try { await fs.lstat(output); throw new Error('Output already exists; choose a new filename.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const info = await probe(capture, signal);
  const stream = info.streams.find(s => s.codec_type === 'video');
  if (stream?.width !== 1920 || stream?.height !== 1082 || stream?.r_frame_rate !== '25/1') {
    throw new Error('Unsupported recorder output; expected 1920x1082 at 25 fps.');
  }
  const pixels = await run('ffmpeg', ['-v', 'error', '-i', capture,
    '-vf', 'crop=2:2:0:1080,scale=1:1:flags=neighbor,format=rgb24', '-f', 'rawvideo', '-'],
  { signal, maxBytes: 1200 * 25 * 3 + 1024 * 1024 });
  const frames = parseMarkers(pixels, scenes.length);
  for (let i = 0; i < scenes.length; i++) {
    const measured = (frames[i].end - frames[i].start) / 25;
    if (Math.abs(measured - scenes[i].duration) > Math.max(0.8, scenes[i].duration * 0.04)) {
      throw new Error('Recorder scene duration drift exceeded tolerance.');
    }
  }
  const timing = audioTiming(frames, scenes, 25);
  const { start, end, duration, originStart, switchAt, secondDuration } = timing;
  const music = [];
  for (const kind of ['Intro', 'Origin']) {
    const uri = payload.chapters.find(c => c.kind === kind).data.videoSequence.find(s => s.kind === 'Music').backgroundVideoUri;
    const asset = await cache.get(uri);
    const track = await probe(asset.file, signal);
    const audio = track.streams.find(s => s.codec_type === 'audio');
    if (!audio || !Number.isFinite(Number(audio.duration ?? track.format?.duration))) {
      throw new Error('Chapter music has no decodable audio duration.');
    }
    music.push(asset.file);
  }
  const filter = [
    `[0:v]trim=start_frame=${start}:end_frame=${end},setpts=PTS-STARTPTS,` +
      `crop=1920:1080:0:0,fade=t=out:st=${duration - 0.6}:d=0.6,format=yuv420p[v]`,
    `[1:a]atrim=duration=${switchAt},asetpts=PTS-STARTPTS,` +
      `aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=1,` +
      `afade=t=out:st=${originStart}:d=0.5[a1]`,
    `[2:a]atrim=duration=${secondDuration},asetpts=PTS-STARTPTS,` +
      `aformat=sample_rates=48000:channel_layouts=stereo,afade=t=in:d=0.5,` +
      `afade=t=out:st=${secondDuration - 1.5}:d=1.5[a2]`,
    '[a1][a2]concat=n=2:v=0:a=1[a]',
  ].join(';');
  // Loop chapter soundtracks if necessary, never use muted background-video audio.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', capture,
    '-stream_loop', '-1', '-i', music[0], '-stream_loop', '-1', '-i', music[1],
    '-filter_complex', filter, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', quality === 'share' ? '21' : '18', '-threads', '4',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart',
    '-map_metadata', '-1', '-metadata', 'title=Xbox Playback', output], { signal });
  await verifyOutput(output, duration, signal);
  return { width: 1920, height: 1080, fps: 25, duration, sceneCount: scenes.length };
}

export async function verifyOutput(file, duration, signal) {
  const result = await probe(file, signal);
  const video = result.streams.find(s => s.codec_type === 'video');
  const audio = result.streams.find(s => s.codec_type === 'audio');
  if (video?.codec_name !== 'h264' || video.width !== 1920 || video.height !== 1080 ||
      video.pix_fmt !== 'yuv420p' || video.r_frame_rate !== '25/1' || audio?.codec_name !== 'aac' ||
      Math.abs(Number(video.duration) - duration) > 0.12 ||
      !Number.isFinite(Number(audio?.duration)) || Math.abs(Number(audio.duration) - duration) > 0.2) {
    throw new Error('Encoded output failed video/audio verification.');
  }
}
