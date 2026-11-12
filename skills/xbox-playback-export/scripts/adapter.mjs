import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';

export const adapterId = 'playback-2026-11-12';
const base = 'https://assets-xbxweb.xbox.com/xbox-web/static/';
export const scripts = [
  ['3524.3b97e426.js', '3157ebcc7be12c3edad758ea3ca90aa723137e68aa48173ebba6f86f4c984667'],
  ['3249.5387a79f.js', '93da2f1a1266660bed8dca0fcc193ccdf13587e1c955fe8da891a41b5855bfe8'],
  ['790.17ea0e57.js', '72284ab14a38cf75b4386cbc4f65faa2368bc7db06e90201d99d1b1ba9a3e006'],
  ['9303.9b294e91.js', 'b39edbeb9728749c27d570e540ae6b59f3f92d12a86ade0b70344f617fc192e9'],
  ['1686.c878bfc6.js', 'ef26d0d3e6236f6c82ad101adf93cc32a5ac1a887514d4279e1bf0ae5f906b06'],
  ['client.ce0773f6.js', '4bd177c005d045861b35fadf867c122233773727c27323c46f292f80eb6502ad'],
  ['9841.b876b3dd.chunk.js', '0c36c228008c12e3cc25cb95095fd2e19f6cfd45815381356806e2c0f871bf6e'],
  ['7571.cf65b2e9.chunk.js', '5a5ba9d0eaaf14e61131cc46bf003b6ba66adf6c7511a2a2490c6f989794ec3e'],
  ['PlaybackVideoPage.5cadca40.chunk.js', 'd9aa886afa01d39f5c1b5e64c38d828389dd2957bfccd0199a78c02cfd686c2d'],
];
export const styles = [
  ['3772.a5189507.css', 'c452a63a83ed9a289a31fb5cc23c5d7410211b00acbbee4e8008df9fc0047d96'],
  ['790.74602aed.css', 'ee44d655c02ee949614647c9b1a6744c23360196eb80a2943cbd536c2e872e80'],
  ['1686.f269e977.css', 'db43c2cbcecc3d7ce4f718abd1e23adf8debc1c8d862728a4a6fda54296f982b'],
  ['client.795940e1.css', '1eb7242fae31dc4f0d56eda40e4fb0b7d30006e573d200606ec8172952b0b08b'],
  ['PlaybackVideoPage.be31798b.chunk.css', '85ae149a7a0b15f16972e2c3a8309319060d2b47d6fe30db820c0df56f04f3cb'],
];

export function verifyDigest(source, expected) {
  if (createHash('sha256').update(source).digest('hex') !== expected) {
    throw new Error('Unsupported Xbox asset build: fingerprint mismatch. No automatic adapter updates are allowed.');
  }
}

export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Unsupported Xbox renderer structure.');
  return source.replace(before, after);
}

export function patchRoute(source) {
  const ast = parse(source, { ecmaVersion: 'latest' });
  const modules = ast.body[1]?.expression?.arguments?.[0]?.elements?.[1];
  const body = modules?.properties?.find(p => p.key.value === 48467)?.value?.body;
  if (!body) throw new Error('Unsupported Xbox route module.');
  const names = body.body.flatMap(node => {
    if (node.type === 'VariableDeclaration') return node.declarations.map(d => d.id.name);
    if (node.type === 'FunctionDeclaration') return [node.id.name];
    return [];
  });
  if (!['Rt', 'lr', 'hr', 'D', 'V', 'z', 'Ae', 'Ie', 'be'].every(n => names.includes(n))) {
    throw new Error('Unsupported Xbox presentation internals.');
  }
  source = replaceOnce(source, 'default:()=>Cr', `default:()=>Cr,internals:()=>({${names.join(',')}})`);
  source = replaceOnce(source, 'l=n(83718)', `l={d4:(selector)=> {
    if(selector===r.yI) return window.payload.userInformation.gamerTag;
    if(selector===r.zv) return window.payload.userInformation.gamerPicUri;
    throw Error('Unsupported presentation selector');
  }}`);
  return replaceOnce(source, 'ae=n(18255)', 'ae={JX:()=>window.payload.commonText.gamerscoreText}');
}

export async function setupPage(page, payload, cache) {
  const errors = [];
  page.on('pageerror', () => errors.push('Original renderer raised an error; presentation shape may be unsupported.'));
  page.on('console', message => {
    if (message.type() === 'error') errors.push('Original renderer reported an error.');
  });
  await page.route('**/*', async route => {
    try {
      let url = route.request().url();
      if (url === 'http://playback.local/' && route.request().method() === 'GET' &&
          route.request().resourceType() === 'document') {
        await route.fulfill({ contentType: 'text/html', body: '<html><head></head><body><div id="root"></div></body></html>' });
        return;
      }
      if (route.request().method() !== 'GET' ||
          ['script', 'document', 'xhr', 'fetch', 'websocket', 'eventsource'].includes(route.request().resourceType())) {
        throw new Error('Unsupported renderer network request.');
      }
      if (url.startsWith('http://playback.local/')) url = url.replace('http://playback.local', 'https://assets-xbxweb.xbox.com');
      const asset = await cache.get(url);
      await route.fulfill({ path: asset.file, contentType: asset.type,
        headers: { 'Access-Control-Allow-Origin': '*' } });
    } catch {
      errors.push('Renderer requested an unavailable or unsupported asset.');
      await route.abort().catch(() => {});
    }
  });
  await page.goto('http://playback.local/');
  await page.evaluate(p => { window.payload = p; }, payload);
  for (const [name, digest] of scripts) {
    const asset = await cache.get(`${base}js/${name}`);
    const bytes = await fs.readFile(asset.file);
    verifyDigest(bytes, digest);
    let source = bytes.toString();
    if (name.startsWith('client.')) {
      const signature = 'var r=n.O(void 0,';
      if (source.split(signature).length !== 2) throw new Error('Unsupported Xbox startup signature.');
      source = source.slice(0, source.lastIndexOf(signature)) + 'window.__req=n;})();';
    }
    if (name.startsWith('PlaybackVideoPage.')) source = patchRoute(source);
    await page.addScriptTag({ content: source });
  }
  for (const [name, digest] of styles) {
    const asset = await cache.get(`${base}css/${name}`);
    const bytes = await fs.readFile(asset.file);
    verifyDigest(bytes, digest);
    await page.addStyleTag({ content: bytes.toString() });
  }
  await page.addStyleTag({ content: `
    html,body,#root { margin:0; width:1920px; height:1080px; overflow:hidden; background:transparent!important; }
    html { font-size:16px; }
    #root { position:relative; color:white; }
  ` });
  await page.evaluate(() => {
    const r = window.__req;
    const p = r(48467).internals;
    const react = r(14041);
    const dom = r(43144);
    const root = dom.createRoot(document.getElementById('root'));
    const sceneCache = new Map();
    window.show = (chapterKind, sceneKind, time, duration) => {
      const key = `${chapterKind}:${sceneKind}:${duration}`;
      let overlay = sceneCache.get(key);
      if (!sceneCache.has(key)) {
        const chapter = window.payload.chapters.find(c => c.kind === chapterKind);
        const scene = chapter.data.videoSequence.find(s => s.kind === sceneKind);
        const cues = p.V(chapter, window.payload);
        // Origin's MP4 already contains the console cuts. Normalize cues, never cut it again.
        const normalized = chapterKind === 'Origin' ? p.D(cues) : { cues, cuts: [] };
        const props = { chapter, ...normalized, commonText: window.payload.commonText,
          userInformation: window.payload.userInformation, locale: 'en-US', presentationEnabled: true };
        const h = react.createElement;
        overlay = chapterKind === 'Intro' ?
          h(p.Rt, { key, scene, presentation: p.z(chapter, window.payload), enabled: true,
            onContinueAvailabilityChange: () => {} }) :
          chapterKind === 'Origin' ? h(p.lr, { key, scene, props }) :
            sceneKind === 'Looping' ? null :
              h(p.hr, { key, scene, data: chapter.data, cues, commonText: props.commonText,
                userInformation: props.userInformation, enabled: true, onExperienceCompleted: () => {} });
        sceneCache.set(key, overlay);
      }
      const h = react.createElement;
      const localization = { locales: ['en-US'], merge: Object.assign, pathSep: '.',
        messages: { 'en-US': { baseStrings: { noCaptionAvailableAltText: () => '' } } },
        onError: () => { throw Error('Unsupported localization key'); } };
      dom.flushSync(() => root.render(h(r(36647).N.Provider, { value: localization },
        h(p.Ae.Provider, { value: { paused: false, reducedMotion: false } },
          h(p.Ie.Provider, { value: { isActive: true, hasPresented: true, isExiting: false,
            state: p.be.Playing,
            nativeSample: { positionSeconds: time, durationSeconds: duration, receivedAt: Date.now() } } },
          overlay)))));
    };
  });
  return errors;
}
