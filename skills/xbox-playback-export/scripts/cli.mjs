import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import { AssetCache } from './assets.mjs';
import { readPayload, selectScenes } from './payload.mjs';
import { run } from './process.mjs';
import { record } from './record.mjs';
import { encode } from './encode.mjs';
import { adapterId } from './adapter.mjs';
import { acquirePresentation, validatePageUrl } from './acquire.mjs';

const help = `Xbox Playback Export (experimental)
  node cli.mjs validate --input /private/presentation.json
  node cli.mjs export --input /private/presentation.json --output /private/playback.mp4
                     [--quality high|share] [--browser msedge|chrome]
  node cli.mjs export --url https://www.xbox.com/en-US/playback --consent headed
                     --output /private/playback.mp4 [--browser msedge|chrome]

Requires Node >=22.16, installed Edge/Chrome, ffmpeg and ffprobe on PATH.
URL mode opens a separate visible browser only after explicit consent.
The user signs in; this tool reads only the loaded presentation, never credentials.
Local temporary data is deleted on success, failure, or Ctrl+C. Outputs are never overwritten.
`;

export function parseArgs(args) {
  if (!args.length || args[0] === '--help' || args[0] === '-h') return { command: 'help' };
  const [command, ...flags] = args;
  if (!['export', 'validate'].includes(command)) throw new Error('Unknown command. Use --help.');
  const options = { command, quality: 'high', browser: 'msedge' };
  const allowed = command === 'export' ? ['input', 'url', 'consent', 'output', 'quality', 'browser'] : ['input'];
  const seen = new Set();
  for (let i = 0; i < flags.length; i += 2) {
    const key = flags[i].replace(/^--/, '');
    const value = flags[i + 1];
    if (!flags[i].startsWith('--') || !allowed.includes(key) || !value || value.startsWith('--') || seen.has(key)) {
      throw new Error('Invalid, duplicate, or missing option. Use --help.');
    }
    seen.add(key);
    options[key] = value;
  }
  if ((!options.input && !options.url) || (options.input && options.url) ||
      command === 'export' && !options.output) throw new Error('Choose exactly one input or URL and a new output. Use --help.');
  if (options.url) {
    validatePageUrl(options.url);
    if (options.consent !== 'headed') throw new Error('Permission for a separate visible browser is required (--consent headed).');
  } else if (options.consent) throw new Error('Browser consent applies only to URL acquisition.');
  if (!['high', 'share'].includes(options.quality) || !['msedge', 'chrome'].includes(options.browser)) {
    throw new Error('Unsupported quality or browser. Use --help.');
  }
  if (options.output && path.extname(options.output).toLowerCase() !== '.mp4') throw new Error('Output must have an .mp4 extension.');
  return options;
}

export async function publishFile(source, destination, signal) {
  const handle = await fs.open(destination, 'wx', 0o600);
  try {
    for await (const chunk of createReadStream(source, { signal })) {
      signal?.throwIfAborted();
      await handle.writeFile(chunk);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.unlink(destination);
    throw error;
  }
  await handle.close();
}

export async function main(args, signal) {
  const options = parseArgs(args);
  if (options.command === 'help') { console.log(help); return; }
  let payload = options.input ? await readPayload(path.resolve(options.input)) : undefined;
  if (options.command === 'validate') {
    console.log(`Presentation shape accepted: ${selectScenes(payload).length} scenes; adapter ${adapterId}. Rendering compatibility is checked during export.`);
    return;
  }
  const output = path.resolve(options.output);
  try { await fs.lstat(output); throw new Error('Output already exists; choose a new filename.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.access(path.dirname(output), fs.constants.W_OK);
  await run('ffmpeg', ['-version'], { signal });
  await run('ffprobe', ['-version'], { signal });
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xbox-playback-export-'));
  await fs.chmod(workDir, 0o700);
  try {
    if (options.url) {
      payload = await acquirePresentation(options.url, { consent: options.consent, channel: options.browser, signal });
    }
    const assetDir = path.join(workDir, 'assets');
    await fs.mkdir(assetDir, { mode: 0o700 });
    const cache = new AssetCache(assetDir, { signal });
    console.log('Downloading assets and rendering silently in a fresh headless browser...');
    const { capture, scenes } = await record(payload, cache, workDir, { signal, channel: options.browser });
    console.log('Encoding and verifying video and chapter soundtracks...');
    const temporaryOutput = path.join(workDir, 'export.mp4');
    const result = await encode(capture, scenes, payload, cache, temporaryOutput, { signal, quality: options.quality });
    signal?.throwIfAborted();
    await publishFile(temporaryOutput, output, signal);
    console.log(`Export saved: ${result.width}x${result.height}, H.264/AAC, ${result.duration.toFixed(2)} seconds.`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try { await main(process.argv.slice(2), controller.signal); }
  catch (error) {
    const code = error?.code;
    console.error(controller.signal.aborted ? 'Export cancelled.' :
      code ? `Local file operation failed (${code}); check input/output locations and permissions.` : error.message);
    process.exitCode = controller.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
