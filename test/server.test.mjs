// End-to-end against a scratch server: fake TTS, scratch data dir, unreachable DJ. Never touches .radio/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4861;
const BASE = `http://localhost:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'radio-test-'));
let proc;

const get = (p) => fetch(BASE + p).then((r) => r.json());
const post = (p, b = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

/** connect like a powered-on tuner tab; resolves with its client id once it has claimed playback */
async function connectPlayer() {
  const ctl = new AbortController();
  const res = await fetch(`${BASE}/api/events?player=1`, { signal: ctl.signal });
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', id = null;
  while (!id) { const { value } = await reader.read(); buf += dec.decode(value); const m = /"id":"([a-z0-9]+)"/.exec(buf); if (m) id = m[1]; }
  await new Promise((r) => setTimeout(r, 50));
  return { id, close: () => ctl.abort() };
}
let player;

before(async () => {
  proc = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { env: { ...process.env, RADIO_PORT: String(PORT), RADIO_DATA: DATA, RADIO_TTS: 'fake', RADIO_DJ_URL: 'http://127.0.0.1:9' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { await get('/api/state'); player = await connectPlayer(); return; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  throw new Error('server did not start');
});
after(() => { player?.close(); proc?.kill(); fs.rmSync(DATA, { recursive: true, force: true }); });

test('presets are on the dial', async () => {
  const list = await get('/api/stations');
  assert.ok(list.length >= 6);
  assert.ok(list.find((s) => s.id === 'the-wire'));
});

test('tune, queue a segment, play it through the player protocol', async () => {
  assert.equal((await post('/api/tune', { station: '91.7' })).station.id, 'the-wire');
  const r = await post('/api/segment', { script: '# title: Test seg\n# source: X | https://x.org\nMARCUS: Hello there, this is a test line.\nPRIYA: [laughs] And this is another.', wait: true });
  assert.equal(r.ok, true);
  assert.equal(r.segment.status, 'ready');
  const w = await get('/api/wait?for=low&seconds=600&timeout=2');
  assert.equal(w.reason, 'low');
  const { segment } = await post('/api/player/next', { client: player.id });
  assert.equal(segment.title, 'Test seg');
  assert.equal(segment.lines[1].host, 'Priya');
  const audio = await fetch(BASE + segment.lines[0].audio);
  assert.equal(audio.status, 200);
  await post('/api/player/done', { id: segment.id });
  const aired = await get('/api/aired?station=the-wire');
  assert.equal(aired.at(-1).title, 'Test seg');
});

test('rejects unknown hosts and segments for a station the listener left', async () => {
  assert.match((await post('/api/segment', { script: 'BOB: hi' })).error, /isn't a host/);
  assert.match((await post('/api/segment', { station: 'long-ago', script: 'ARTHUR: hi' })).error, /listener is on/);
});

test('typed station → inbox → Claude creates and tunes it', async () => {
  await post('/api/tune', { prompt: 'grumpy chefs on food history', source: 'ui' });
  const w = await get('/api/wait?for=time&seconds=1&timeout=2');
  assert.ok(['inbox', 'time'].includes(w.reason));
  const inbox = await get('/api/inbox?clear=1');
  assert.equal(inbox.at(-1).type, 'new-station');
  assert.equal((await get('/api/state')).pending.prompt, 'grumpy chefs on food history');
  const c = await post('/api/stations', { name: 'Mise en Place', format: 'talk', hosts: [{ name: 'Bruno', voice: 'Bill' }, { name: 'Dee', voice: 'Laura' }] });
  assert.equal(c.station.id, 'mise-en-place');
  assert.ok(c.station.freq >= 88 && c.station.freq <= 108);
  await post('/api/tune', { station: 'mise-en-place' });
  const s = await get('/api/state');
  assert.equal(s.station.id, 'mise-en-place');
  assert.equal(s.pending, null);
  assert.equal((await post('/api/segment', { script: 'DEE: Wrong, Bruno.', wait: true })).segment.status, 'ready');
});

test('skip ends the segment on the server even if the tab never reports back', async () => {
  await post('/api/tune', { station: 'the-wire' });
  await post('/api/segment', { script: 'MARCUS: A line to skip.', wait: true });
  const { segment } = await post('/api/player/next', { client: player.id });
  assert.equal((await get('/api/state')).onAir.id, segment.id);
  assert.equal((await post('/api/skip')).skipped, segment.title);
  assert.equal((await get('/api/state')).onAir, null);
  await post('/api/player/done', { id: segment.id }); // the late report from the tab is harmless
  assert.equal((await get('/api/state')).onAir, null);
});

test('updating the tuned station refreshes it', async () => {
  await post('/api/tune', { station: 'mise-en-place' });
  await post('/api/stations', { id: 'mise-en-place', name: 'Mise en Place', tagline: 'new tagline', format: 'talk', hosts: [{ name: 'Bruno', voice: 'Bill' }], overwrite: true });
  const s = await get('/api/state');
  assert.equal(s.station.tagline, 'new tagline');
  assert.deepEqual(s.station.hosts.map((h) => h.name), ['Bruno']);
});

test('the tuner knows whether Claude is listening (open waits, incl. killed clients)', async () => {
  assert.equal((await get('/api/state')).claude.watching, false);
  const ctl = new AbortController();
  const pending = fetch(`${BASE}/api/wait?for=time&seconds=30&timeout=30`, { signal: ctl.signal }).catch(() => null);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await get('/api/state')).claude.watching, true);
  ctl.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await get('/api/state')).claude.watching, false);
});

test('only the latest powered-on tab gets segments', async () => {
  await post('/api/tune', { station: 'the-wire' });
  await post('/api/segment', { script: 'MARCUS: Two tabs, one radio.', wait: true });
  const second = await connectPlayer();
  assert.equal((await post('/api/player/next', { client: player.id })).segment, null);
  const { segment } = await post('/api/player/next', { client: second.id });
  assert.equal(segment.title, 'Two tabs, one radio.');
  await post('/api/player/done', { id: segment.id });
  second.close();
  player = await connectPlayer(); // hand it back for the remaining tests
});

test('notebook persists per station', async () => {
  await post('/api/notes', { station: 'the-wire', text: 'covered: rate decision' });
  assert.match((await get('/api/notes?station=the-wire')).notebook, /rate decision/);
});
