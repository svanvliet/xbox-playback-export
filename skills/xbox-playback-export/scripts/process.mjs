import { spawn } from 'node:child_process';

export async function run(command, args, { signal, maxBytes = 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    let bytes = 0;
    let problem;
    let killTimer;
    const stop = error => {
      problem ??= error;
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000);
      killTimer.unref();
    };
    const abort = () => stop(new Error('Export cancelled.'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop(new Error(`${command} output exceeded its safety limit.`));
      else output.push(chunk);
    });
    // Drain diagnostics, but never echo media URLs, personalized values, or paths.
    child.stderr.resume();
    child.on('error', () => { problem ??= new Error(`Cannot start ${command}; install it and add it to PATH.`); });
    child.on('close', code => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      if (problem) reject(problem);
      else if (code !== 0) reject(new Error(`${command} failed (exit ${code}); input media may be unsupported.`));
      else resolve(Buffer.concat(output));
    });
  });
}

export async function probe(file, signal) {
  const result = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  return JSON.parse(result.toString());
}
