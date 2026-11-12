import path from 'node:path';
import { chromium } from 'playwright';
import { setupPage } from './adapter.mjs';
import { probe } from './process.mjs';
import { selectScenes } from './payload.mjs';

export const markerColors = [
  [255, 0, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [0, 255, 255], [255, 255, 255],
];

export async function planScenes(payload, cache, signal) {
  const scenes = selectScenes(payload);
  if (scenes.length > markerColors.length - 1) throw new Error('Unsupported number of presentation scenes.');
  for (const scene of scenes) {
    const asset = await cache.get(scene.uri);
    const info = await probe(asset.file, signal);
    const stream = info.streams.find(s => s.codec_type === 'video');
    const mediaDuration = Number(stream?.duration ?? info.format?.duration);
    if (!stream || stream.width !== 1920 || stream.height !== 1080 ||
        !Number.isFinite(mediaDuration) || mediaDuration <= 0 || mediaDuration > 600) {
      throw new Error('Unsupported background video dimensions or duration.');
    }
    scene.duration = scene.looping ? 3 : mediaDuration;
  }
  if (scenes.reduce((n, s) => n + s.duration, 0) > 1200) throw new Error('Presentation exceeds the 20-minute limit.');
  return scenes;
}

export async function record(payload, cache, workDir, { signal, channel = 'msedge' } = {}) {
  const scenes = await planScenes(payload, cache, signal);
  signal?.throwIfAborted();
  let browser;
  try {
    browser = await chromium.launch({ channel, headless: true, args: ['--mute-audio',
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding'] });
  } catch { throw new Error('Cannot launch headless browser. Install Microsoft Edge, or use --browser chrome with installed Chrome.'); }
  const abort = () => { void browser.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let context;
  try {
    signal?.throwIfAborted();
    context = await browser.newContext({ viewport: { width: 1920, height: 1082 }, deviceScaleFactor: 1,
      serviceWorkers: 'block', acceptDownloads: false,
      recordVideo: { dir: path.join(workDir, 'recording'), size: { width: 1920, height: 1082 } } });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    const errors = await setupPage(page, payload, cache);
    const cdp = await context.newCDPSession(page);
    // Playwright's recorder otherwise crops this viewport to the browser's default visible surface.
    await cdp.send('Emulation.setVisibleSize', { width: 1920, height: 1082 });
    for (const scene of scenes) {
      const positions = scene.kind === 'Origin' ? [0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95] : [0.5, 0.9];
      for (const fraction of positions) {
        await page.evaluate(({ scene, fraction }) => window.show(scene.chapter, scene.kind,
          scene.duration * fraction, scene.duration), { scene, fraction });
        await page.waitForTimeout(100);
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.decode()));
        });
      }
    }
    const fontLoaded = await page.evaluate(() => [...document.fonts].some(font => font.status === 'loaded' &&
      /Segoe/i.test(font.family)));
    if (!fontLoaded) throw new Error('Original Segoe font failed to load.');
    if (errors.length) throw new Error(errors[0]);
    await page.evaluate(async scenes => {
      window.backgrounds = await Promise.all(scenes.map(async scene => {
        const video = document.createElement('video');
        video.muted = true;
        video.loop = scene.looping;
        video.preload = 'auto';
        video.playsInline = true;
        video.controls = false;
        Object.assign(video.style, { position: 'absolute', inset: '0', width: '1920px',
          height: '1080px', objectFit: 'cover', display: 'none' });
        document.body.insertBefore(video, document.getElementById('root'));
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error('Background media load timed out')), 60000);
          video.addEventListener('canplaythrough', () => { clearTimeout(timer); resolve(); }, { once: true });
          video.addEventListener('error', () => { clearTimeout(timer); reject(Error('Background media failed')); }, { once: true });
          video.src = scene.uri;
        });
        return video;
      }));
      document.getElementById('root').style.zIndex = '1';
      for (const [id, style] of [
        ['marker', { inset: '0', zIndex: '99999' }],
        ['timing-band', { top: '1080px', left: '0', width: '1920px', height: '2px', zIndex: '100000' }],
      ]) {
        const element = document.createElement('div');
        element.id = id;
        Object.assign(element.style, { position: 'fixed', background: '#ff00ff', ...style });
        document.body.appendChild(element);
      }
    }, scenes);
    await page.waitForTimeout(600);
    // An outer deadline also covers a stalled requestVideoFrameCallback.
    await Promise.race([
      page.evaluate(async ({ scenes, colors }) => {
        for (let i = 0; i < scenes.length; i++) {
          const scene = scenes[i];
          const video = window.backgrounds[i];
          if (i > 0) window.backgrounds[i - 1].style.display = 'none';
          video.style.display = 'block';
          window.show(scene.chapter, scene.kind, 0, scene.duration);
          await video.play();
          await new Promise(resolve => video.requestVideoFrameCallback(resolve));
          if (i === 0) document.getElementById('marker').style.display = 'none';
          document.getElementById('timing-band').style.background = `rgb(${colors[i + 1].join(',')})`;
          const started = performance.now();
          let previousTime = video.currentTime;
          let advancedAt = started;
          await new Promise((resolve, reject) => {
            const tick = () => {
              const now = performance.now();
              if (video.error) return reject(Error('Background video decode failed'));
              if (video.currentTime !== previousTime) { previousTime = video.currentTime; advancedAt = now; }
              if (now - advancedAt > 10000) return reject(Error('Background video stalled'));
              window.show(scene.chapter, scene.kind, video.currentTime, scene.duration);
              if (document.querySelector('button,video[controls],[data-outro-end-card]')) {
                return reject(Error('Interactive control appeared in export'));
              }
              if (video.ended || scene.looping && now - started >= scene.duration * 1000) {
                video.pause();
                return resolve();
              }
              if (now - started > (scene.duration + 15) * 1000) return reject(Error('Scene capture timed out'));
              requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });
        }
        document.getElementById('marker').style.display = 'block';
        document.getElementById('timing-band').style.background = '#ff00ff';
      }, { scenes, colors: markerColors }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Capture exceeded its time limit.')),
          (scenes.reduce((n, s) => n + s.duration, 0) + scenes.length * 15 + 10) * 1000);
        timer.unref();
        page.once('close', () => clearTimeout(timer));
      }),
    ]);
    await page.waitForTimeout(600);
    if (errors.length) throw new Error(errors[0]);
    const recording = page.video();
    await context.close();
    context = undefined;
    const capture = path.join(workDir, 'capture.webm');
    await recording.saveAs(capture);
    return { capture, scenes };
  } catch (error) {
    if (signal?.aborted) throw new Error('Export cancelled.');
    // Browser errors may include payload-derived URLs or source excerpts.
    const safe = /^(Original |Renderer requested |Original Segoe |Capture exceeded |Interactive control)/;
    throw new Error(safe.test(error.message) ? error.message : 'Capture failed; media, payload, or site adapter may be unsupported.');
  } finally {
    signal?.removeEventListener('abort', abort);
    if (context) await context.close().catch(() => {});
    await browser.close();
  }
}
