import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const api = (base, p, body) => fetch(base + p, body === undefined ? {} : {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());
export async function until(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  do { const value = await fn(); if (value) return value; await delay(80); } while (Date.now() < end);
  throw new Error('Timed out waiting for combined app');
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
export async function player(base) {
  const ctl = new AbortController();
  const response = await fetch(base + '/api/events?player=1', { signal: ctl.signal });
  const reader = response.body.getReader();
  let buf = '', id;
  while (!id) { const { value } = await reader.read(); buf += new TextDecoder().decode(value); id = /"id":"([a-z0-9]+)"/.exec(buf)?.[1]; }
  await delay(40);
  return { id, close: () => ctl.abort() };
}

// Own code, data, ports and processes. Never scans the user's crate or calls TTS.
export async function combined({ station } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-dj-combined-'));
  const djDir = path.join(dir, 'dj');
  const radioPort = await freePort(), djPort = await freePort();
  for (const f of ['server.mjs', 'radio.mjs', 'package.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  for (const d of ['lib', 'public', 'stations']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  fs.mkdirSync(djDir);
  for (const f of ['server.mjs', 'dj.mjs', 'package.json']) fs.copyFileSync(path.join(ROOT, 'dj', f), path.join(djDir, f));
  for (const d of ['lib', 'public', 'cli-ext']) fs.cpSync(path.join(ROOT, 'dj', d), path.join(djDir, d), { recursive: true });
  const djConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'dj/config.json'), 'utf8'));
  fs.mkdirSync(path.join(djDir, 'library'));
  fs.writeFileSync(path.join(djDir, 'config.json'), JSON.stringify({ ...djConfig, port: djPort, libraryDirs: ['./library'], downloadDir: './library', stems: { enabled: false, auto: false }, autoDJ: { enabled: false }, monitor: { enabled: false }, deadAirGuard: false }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: radioPort, dj: { dir: './dj', url: `http://localhost:${djPort}`, duckLevel: 0.3 } }));
  if (station) {
    fs.mkdirSync(path.join(dir, '.radio'));
    fs.writeFileSync(path.join(dir, '.radio', 'state.json'), JSON.stringify({ station }));
  }
  const processes = [], logs = [];
  const stop = async () => {
    for (const proc of processes) {
      if (proc.exitCode === null) {
        const done = new Promise((resolve) => proc.once('exit', resolve));
        proc.kill(); await done;
      }
    }
    if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unexpected scratch path');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    for (const [cwd, env] of [[djDir, { DJ_PORT: String(djPort), DJ_NO_BACKFILL: '1' }], [dir, { RADIO_PORT: String(radioPort), RADIO_DJ_URL: `http://localhost:${djPort}`, RADIO_TTS: 'fake', RADIO_DATA: path.join(dir, '.radio') }]]) {
      const proc = spawn(process.execPath, ['server.mjs'], { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('error', (e) => logs.push(e.message));
      proc.stdout.on('data', (d) => logs.push(String(d))); proc.stderr.on('data', (d) => logs.push(String(d)));
      processes.push(proc);
      const base = `http://localhost:${env.DJ_PORT || env.RADIO_PORT}`;
      await until(() => api(base, '/api/state').catch(() => false));
    }
    return { dir, djDir, radioPort, djPort, base: `http://localhost:${radioPort}`, djBase: `http://localhost:${djPort}`, logs, stop };
  } catch (e) { await stop(); throw new Error(`${e.message}\n${logs.join('')}`); }
}
