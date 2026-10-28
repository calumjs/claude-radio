#!/usr/bin/env node
// `radio` — the control surface Claude uses to run the station. Talks to server.mjs over HTTP.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.mjs';
import { djEnvironment } from './lib/dj-bridge.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(ROOT);
const PORT = Number(process.env.RADIO_PORT || config.port);
const BASE = `http://localhost:${PORT}`;

const argv = process.argv.slice(2);
const pos = [], flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (pos[0] === 'dj') { pos.push(a); continue; } // everything after `dj` goes to the DJ CLI untouched
  if (a.startsWith('--')) { const k = a.slice(2); if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i]; else flags[k] = true; }
  else pos.push(a);
}
const [cmd = 'help', ...rest] = pos;
const JSON_OUT = !!flags.json;

async function api(p, body, method) {
  let res;
  try { res = await fetch(BASE + p, body !== undefined ? { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}); }
  catch { fail('Radio server is not running. Start it with:  node radio.mjs start'); }
  const t = await res.text();
  try { return JSON.parse(t); } catch { return t; }
}
function fail(msg) { console.error(`✗ ${msg}`); process.exit(1); }
const out = (x) => console.log(typeof x === 'string' ? x : JSON.stringify(x, null, 2));
const check = (r) => { if (r && r.ok === false) fail(r.error); return r; };
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const readSrc = (a) => (a === '-' || a === undefined ? fs.readFileSync(0, 'utf8') : fs.existsSync(a) ? fs.readFileSync(a, 'utf8') : a);

function fmtStatus(s) {
  const L = [];
  if (!s.listeners) L.push(`⚠ No listener: open ${BASE} and click "Power on" (browsers need one click before they play audio).`);
  if (s.station) {
    const st = s.station;
    L.push(`ON AIR  ${st.freq.toFixed(1)} ${st.name}  [${st.id}]  ${st.format}${st.tagline ? '  · ' + st.tagline : ''}`);
    L.push(`HOSTS   ${st.hosts.map((h) => `${h.name} (${h.role}, voice ${h.voice})`).join(' · ')}`);
  } else if (s.pending) L.push(`📡 STATIC  listener asked for a new station: "${s.pending.prompt}" → build it (radio-station skill)`);
  else L.push('📡 STATIC  nothing tuned. node radio.mjs tune <station>');
  if (s.onAir) L.push(`NOW     "${s.onAir.title}"  line ${s.onAir.line + 1}: ${s.onAir.host}: ${s.onAir.text?.slice(0, 80)}`);
  L.push(`QUEUE   ${mmss(s.queuedSec)} of programme left  (${s.queue.length} segment${s.queue.length === 1 ? '' : 's'})${s.queue.length ? ': ' + s.queue.map((q) => `${q.title} [${q.status}]`).join(' · ') : ''}`);
  if (s.deadAir) L.push('⚠ DEAD AIR: nothing queued. Get a segment on now (even a short one), then research the next.');
  for (const q of s.queue.filter((x) => x.status === 'error')) L.push(`⚠ ${q.title}: ${q.error}`);
  const d = s.dj;
  if (s.station && s.station.format !== 'talk') {
    if (!d.reachable) L.push(`MUSIC   Claude DJ not running (${d.installed ? 'node radio.mjs dj-start' : 'not installed: git submodule update --init'})`);
    else if (!d.engine) L.push('MUSIC   ⚠ DJ engine not started: the listener must click "Start engine" in the music panel of the tuner');
    else L.push(`MUSIC   ${d.nowPlaying ? `${d.nowPlaying.artist ? d.nowPlaying.artist + ' - ' : ''}${d.nowPlaying.title}  ${d.nowPlaying.bpm ?? '?'} BPM ${d.nowPlaying.camelot ?? ''}  ${d.nowPlaying.remaining != null ? mmss(d.nowPlaying.remaining) + ' left' : ''}` : 'silent'}${d.ducked ? '  (ducked)' : ''}`);
  }
  if (s.inbox) L.push(`📨 ${s.inbox} listener message(s): node radio.mjs inbox --clear`);
  L.push(`VOICES  ${s.tts}`);
  return L.join('\n');
}

const commands = {
  async start() {
    try { await fetch(BASE + '/api/state'); console.log(`✓ Already running at ${BASE}`); }
    catch {
      const logFile = path.join(ROOT, '.radio', 'server.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const fd = fs.openSync(logFile, 'a');
      spawn(process.execPath, [path.join(ROOT, 'server.mjs')], { detached: true, stdio: ['ignore', fd, fd], cwd: ROOT, windowsHide: true }).unref();
      for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 250)); try { await fetch(BASE + '/api/state'); break; } catch { /* waiting */ } }
      console.log(`✓ Radio server started at ${BASE}  (log: .radio/server.log)`);
    }
    if (!flags['no-open']) await commands.open();
  },
  async open() {
    const o = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', BASE]] : process.platform === 'darwin' ? ['open', [BASE]] : ['xdg-open', [BASE]];
    spawn(o[0], o[1], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log(`✓ Opened ${BASE}`);
  },
  async status() { const s = await api('/api/state'); JSON_OUT ? out(s) : console.log(fmtStatus(s)); },

  async stations() {
    const list = await api('/api/stations');
    if (JSON_OUT) return out(list);
    for (const s of list) console.log(`${s.freq.toFixed(1).padStart(5)}  ${s.id.padEnd(22)} ${s.format.padEnd(6)} ${s.name}${s.custom ? '  (custom)' : ''}${s.tagline ? '  · ' + s.tagline : ''}`);
  },
  async station() {
    const sub = rest[0];
    if (sub === 'create' || sub === 'update') {
      const def = JSON.parse(readSrc(rest[1]));
      if (sub === 'update') def.overwrite = true;
      const r = check(await api('/api/stations', def));
      console.log(`✓ ${r.station.freq.toFixed(1)} ${r.station.name} [${r.station.id}]  hosts: ${r.station.hosts.map((h) => h.name).join(', ')}`);
      if (flags.tune) await commands.tune(r.station.id);
      return;
    }
    if (sub === 'rm') { check(await api(`/api/stations/${encodeURIComponent(rest[1])}`, {}, 'DELETE')); return console.log('✓ removed'); }
    const list = await api('/api/stations');
    const s = sub ? list.find((x) => x.id === sub || x.freq.toFixed(1) === sub) : (await api('/api/state')).station;
    if (!s) fail(`no station "${sub ?? ''}"`);
    out(s);
  },
  async tune(id = rest[0]) {
    if (!id) fail('usage: radio tune <station id | frequency | name>');
    const r = check(await api('/api/tune', { station: id, source: 'cli' }));
    console.log(`✓ tuned to ${r.station.freq.toFixed(1)} ${r.station.name}`);
  },
  async voices() {
    const v = await api(`/api/voices${flags.refresh ? '?refresh=1' : ''}`);
    if (JSON_OUT) return out(v);
    const f = rest.join(' ').toLowerCase();
    for (const x of v) {
      const l = Object.values(x.labels || {}).join(', ');
      if (f && !`${x.fullName} ${l} ${x.description}`.toLowerCase().includes(f)) continue;
      console.log(`${x.id}  ${x.fullName.padEnd(44)} ${x.category.padEnd(12)} ${l}`);
    }
  },

  async segment() {
    const script = readSrc(rest[0]);
    const r = check(await api('/api/segment', { script, next: !!flags.next, wait: !!flags.wait }));
    console.log(`✓ queued "${r.segment.title}" (${r.segment.lines.length} lines, ~${Math.round(r.segment.dur)}s, ${r.segment.status})  ·  ${mmss(r.queuedSec)} of programme queued`);
  },
  async say() {
    const [host, ...words] = rest;
    if (!host || !words.length) fail('usage: radio say <host> "text" [--next]');
    const r = check(await api('/api/segment', { script: `# title: ${flags.title || words.join(' ').slice(0, 40)}\n${host}: ${words.join(' ')}`, next: !!flags.next }));
    console.log(`✓ queued (${Math.round(r.segment.dur)}s)`);
  },
  async jingle() {
    const prompt = rest.join(' ');
    if (!prompt) fail('usage: radio jingle "<sound prompt>" [--seconds 4]');
    const r = check(await api('/api/segment', { title: flags.title || 'Station ident', kind: 'ident', duck: false, lines: [{ sfx: prompt, seconds: Number(flags.seconds || 4) }], next: !!flags.next }));
    console.log(`✓ queued ident (${r.segment.status})`);
  },
  async queue() {
    if (rest[0] === 'clear') { check(await api('/api/queue/clear', {})); return console.log('✓ queue cleared'); }
    if (rest[0] === 'rm') { check(await api(`/api/queue/${rest[1]}`, {}, 'DELETE')); return console.log('✓ removed'); }
    const q = await api('/api/queue');
    if (JSON_OUT) return out(q);
    if (q.onAir) console.log(`▶ ${q.onAir.title}  (line ${q.onAir.line + 1})`);
    for (const s of q.queue) console.log(`  ${s.id.padEnd(5)} ${s.status.padEnd(7)} ~${Math.round(s.dur)}s  ${s.title}${s.error ? '  ⚠ ' + s.error : ''}`);
    console.log(`${mmss(q.queuedSec)} queued`);
  },
  async skip() { check(await api('/api/skip', {})); console.log('✓ skipped'); },

  async wait() {
    const kind = rest[0] || 'low';
    const qs = new URLSearchParams({ for: kind, timeout: String(flags.timeout || 55) });
    if (kind === 'time') qs.set('seconds', rest[1] || flags.seconds || '10');
    else if (flags.seconds) qs.set('seconds', flags.seconds);
    if (flags['ignore-inbox']) qs.set('inbox', 'ignore');
    const r = await api(`/api/wait?${qs}`);
    if (JSON_OUT) return out(r);
    console.log(`⏱ ${r.reason} after ${r.waitedSec}s  ·  ${mmss(r.queuedSec)} queued  ·  station ${r.station || '(static)'}`);
    for (const m of r.inbox || []) console.log(`📨 [${m.type}] ${m.text}`);
  },
  async inbox() {
    const items = await api(`/api/inbox${flags.clear ? '?clear=1' : ''}`);
    if (JSON_OUT) return out(items);
    if (!items.length) return console.log('(inbox empty)');
    for (const m of items) console.log(`📨 [${m.type}] ${m.text}`);
  },
  async booth() { await api('/api/say', { text: rest.join(' ') }); console.log('✓ posted'); },
  async notes() {
    if (rest[0] === 'add') { check(await api('/api/notes', { text: rest.slice(1).join(' '), station: flags.station })); return console.log('✓ noted'); }
    const r = await api(`/api/notes${rest[0] ? '?station=' + encodeURIComponent(rest[0]) : ''}`);
    console.log(r.notebook || '(notebook empty)');
  },
  async aired() {
    const list = await api(`/api/aired?n=${flags.n || 15}${flags.station ? '&station=' + flags.station : ''}`);
    if (JSON_OUT) return out(list);
    for (const a of list) console.log(`${new Date(a.ts).toTimeString().slice(0, 5)}  ${a.title}${a.sources?.length ? '  [' + a.sources.map((s) => s.title).join('; ') + ']' : ''}`);
  },
  async log() { for (const e of await api(`/api/log?n=${flags.n || 30}`)) console.log(`${new Date(e.ts).toTimeString().slice(0, 8)}  ${e.kind.padEnd(8)} ${e.text}`); },

  async 'dj-start'() { const r = check(await api('/api/dj/start', {})); console.log(`✓ Claude DJ ${r.result}. The listener clicks "Start engine" in the tuner's music panel once.`); },
  async dj() {
    const dir = path.resolve(ROOT, config.dj.dir);
    if (!fs.existsSync(path.join(dir, 'dj.mjs'))) fail(`Claude DJ not found at ${dir} (git submodule update --init, or set dj.dir in config.local.json)`);
    const env = djEnvironment(process.env.RADIO_DJ_URL || config.dj.url);
    const p = spawn(process.execPath, [path.join(dir, 'dj.mjs'), ...rest], { cwd: dir, env, stdio: 'inherit', windowsHide: true });
    p.on('error', (e) => fail(e.message));
    p.on('close', (code) => process.exit(code ?? 0));
  },
  async help() {
    console.log(`radio — Claude Radio control surface (server ${BASE})

SETUP     start [--no-open] | open | status [--json]
STATIONS  stations                         list the dial
          station [id|freq]                full definition (hosts, brief, clock)
          station create <file|json|->     build a station  [--tune]
          station update <file|json|->     overwrite a custom station
          station rm <id>
          tune <id|freq|name>
          voices [filter] [--refresh]      ElevenLabs voices for casting
ON AIR    segment <file|-> [--next]        queue a script (NAME: line … ; # title/source/duck/kind)
          say <host> "text" [--next]       one quick line
          jingle "<sound prompt>" [--seconds 4]   ElevenLabs sound effect ident
          queue | queue clear | queue rm <id> | skip
PACING    wait low [--seconds 60]          returns when less than N s of programme is left
          wait empty | wait music [--seconds 30] | wait time <s>
          (every wait returns early on a listener message; --timeout ≤ 55 keeps you responsive)
LISTENER  inbox [--clear]                  requests + tune events from the tuner
          booth "text"                     a line in the booth feed (not spoken)
MEMORY    notes [station] | notes add "text"    the station notebook (covered, running bits, leads)
          aired [--n 15]                   what has actually gone out
MUSIC     dj-start                         start Claude DJ (embedded in the tuner)
          dj <dj args…>                    run the Claude DJ CLI, e.g. radio dj load A "Sandstorm"`);
  },
};

const fn = commands[cmd];
if (!fn) fail(`unknown command "${cmd}" (node radio.mjs help)`);
await fn();
