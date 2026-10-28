#!/usr/bin/env node
// Claude Radio server: serves the tuner, holds stations and the on-air queue, renders host lines with
// ElevenLabs, and long-polls `radio wait` so Claude (in Claude Code) knows when to write the next segment.
// The browser tab is the sound system: it pulls ready segments and plays them line by line.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Eleven, estimateSec, stripTags } from './lib/eleven.mjs';
import { Stations } from './lib/stations.mjs';
import { parseScript } from './lib/script.mjs';
import { DJBridge } from './lib/dj-bridge.mjs';
import { loadConfig } from './lib/config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig(ROOT);
const DATA = path.resolve(ROOT, process.env.RADIO_DATA || '.radio');
const PORT = Number(process.env.RADIO_PORT || config.port);
fs.mkdirSync(DATA, { recursive: true });

// ---------------------------------------------------------------- state
const log = [];
function addLog(kind, text, extra = {}) {
  const e = { ts: Date.now(), kind, text, ...extra };
  log.push(e); if (log.length > 300) log.shift();
  broadcast('log', e);
  return e;
}
const clients = new Map();      // id -> { res, player }
const inbox = [];               // listener requests + tune events, for Claude
let queue = [];                 // segments for the current station, in air order
let onAir = null;               // { seg, line, startedAt }
let lastAirAt = Date.now();
let deadAirWarned = false;
let segSeq = 0;
const stateFile = path.join(DATA, 'state.json');
const saved = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } })();

const stations = new Stations({ presetDir: path.join(ROOT, 'stations'), dataDir: path.join(DATA, 'stations') });
let current = stations.get(saved.station) || null;
let pending = null;             // a typed station prompt Claude hasn't built yet

const eleven = new Eleven({ dir: path.join(DATA, 'audio'), ...config.elevenlabs, log: (t) => addLog('system', t) });
const dj = new DJBridge({
  dir: path.resolve(ROOT, config.dj.dir), url: process.env.RADIO_DJ_URL || config.dj.url, duckLevel: config.dj.duckLevel,
  log: (t) => addLog('system', t),
  onState: (s) => broadcast('dj', s),
});
setInterval(() => musicTask(dj.poll().then(() => {
  // A DJ engine may connect after a saved talk station was loaded.
  if ((current?.format === 'talk' || pending) && !dj.suspended) return dj.setMusicEnabled(false);
})), 2000).unref();
dj.poll();
const musicTask = (job) => job.catch((e) => addLog('system', `Claude DJ: ${e.message}`));
const releaseMusic = () => musicTask(dj.duck(false));

const persist = () => fs.writeFileSync(stateFile, JSON.stringify({ station: current?.id || null }));

// ---------------------------------------------------------------- helpers
function broadcast(event, data, playersOnly = false) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients.values()) if (!playersOnly || c.player) c.res.write(msg);
}
function send(res, code, body) {
  const str = typeof body === 'string';
  res.writeHead(code, { 'content-type': str ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store' });
  res.end(str ? body : JSON.stringify(body));
}
async function readBody(req) { let s = ''; for await (const c of req) s += c; try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
function serveFile(res, file) {
  let st; try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': file.includes('audio') ? 'max-age=86400' : 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const players = () => [...clients.values()].filter((c) => c.player).length;
// one tab plays at a time (like Claude DJ's engine claim): the latest to power on; the rest stand by
let activePlayer = null;
function claimPlayer(id) {
  if (activePlayer !== id) releaseMusic();
  activePlayer = id;
  broadcast('player', { active: id });
}
const segDur = (s) => s.lines.reduce((a, l) => a + (l.dur ?? estimateSec(l.text)) + 0.25, 0);
const pub = (s) => ({ id: s.id, station: s.station, title: s.title, kind: s.kind, status: s.status, duck: s.duck, sources: s.sources, error: s.error, dur: +segDur(s).toFixed(1), lines: s.lines.map((l) => ({ host: l.host, text: l.text, audio: l.audio, dur: l.dur })) });

/** seconds of programme still to air: the rest of the segment on air + everything queued */
function queuedSec() {
  let sec = queue.filter((s) => s.status !== 'error').reduce((a, s) => a + segDur(s), 0);
  if (onAir) sec += Math.max(0, segDur(onAir.seg) - (Date.now() - onAir.startedAt) / 1000);
  return +sec.toFixed(1);
}

function state() {
  return {
    station: current, pending,
    stations: stations.list().map((s) => ({ id: s.id, name: s.name, freq: s.freq, format: s.format, tagline: s.tagline, custom: s.custom })),
    onAir: onAir ? { id: onAir.seg.id, title: onAir.seg.title, line: onAir.line, host: onAir.seg.lines[onAir.line]?.host, text: onAir.seg.lines[onAir.line]?.text, sources: onAir.seg.sources } : null,
    queue: queue.map(pub),
    queuedSec: queuedSec(),
    deadAir: !!(current && players() && !onAir && !queue.some((s) => s.status === 'ready') && Date.now() - lastAirAt > 5000),
    listeners: players(),
    claude: { watching: waiters > 0 },
    inbox: inbox.length,
    tts: eleven.fake ? 'fake (silent test audio)' : `ElevenLabs ${eleven.model}`,
    dj: dj.summary(),
    djDir: dj.dir,
  };
}
const pushQueue = () => broadcast('queue', { queue: queue.map(pub), queuedSec: queuedSec() });

// ---------------------------------------------------------------- tuning
function tune(st, source = 'cli') {
  if (current?.id !== st.id) {
    onAir = null;
    broadcast('onair', null);
    if (st.format !== 'talk') releaseMusic();
  }
  current = st;
  pending = null;
  queue = queue.filter((s) => s.station === st.id);
  persist();
  addLog('tune', `📻 ${st.freq.toFixed(1)} ${st.name}${st.tagline ? ' · ' + st.tagline : ''}`);
  broadcast('tune', { station: st, source });
  pushQueue();
  if (source === 'ui') inbox.push({ ts: Date.now(), type: 'tune', station: st.id, text: `Listener tuned to ${st.freq.toFixed(1)} ${st.name}` });
  musicTask(dj.setMusicEnabled(st.format !== 'talk', { resume: !!activePlayer }));
}

// ---------------------------------------------------------------- segments
async function hostVoice(st, name) {
  const h = st.hosts.find((x) => x.key === name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || x.name.toLowerCase() === name.toLowerCase());
  if (!h) throw new Error(`"${name}" isn't a host on ${st.name} (hosts: ${st.hosts.map((x) => x.name).join(', ')})`);
  return { host: h, voiceId: await eleven.resolveVoice(h.voice) };
}

async function addSegment(body) {
  const st = body.station ? stations.get(body.station) : current;
  if (!st) throw new Error('no station tuned (node radio.mjs tune <station>)');
  if (current && st.id !== current.id) throw new Error(`the listener is on ${current.name} now; segment for ${st.name} dropped`);
  const parsed = body.script ? parseScript(body.script) : body;
  const seg = { id: `s${++segSeq}`, station: st.id, title: parsed.title, kind: parsed.kind || 'talk', duck: parsed.duck !== false, sources: parsed.sources || [], status: 'synth', createdAt: Date.now(), lines: [] };
  const resolved = [];
  for (const l of parsed.lines) {
    if (l.sfx || /^sfx$/i.test(l.host)) {
      // "SFX: radio static sweep (3s)" → an ElevenLabs sound effect inside the segment
      const prompt = l.sfx || l.text, secs = /((d+(?:.d+)?)s*s)s*$/.exec(prompt);
      resolved.push({ l: { sfx: prompt.replace(/s*([d.]+s*s)s*$/, ''), seconds: secs ? Number(secs[1]) : l.seconds || 3 }, sfx: true });
      continue;
    }
    resolved.push({ l, ...(await hostVoice(st, l.host)) });
  }
  seg.lines = resolved.map(({ l, host }) => ({ host: host ? host.name : 'SFX', text: l.text || l.sfx, color: host?.color }));
  if (body.next) {
    const at = queue.findIndex((s) => s.status !== 'playing');
    queue.splice(at < 0 ? queue.length : at, 0, seg);
  } else queue.push(seg);
  pushQueue();
  const job = Promise.all(resolved.map(async ({ l, voiceId, sfx }, i) => {
    const r = sfx ? await eleven.sfx(l.sfx, l.seconds || 4) : await eleven.tts(voiceId, l.text);
    Object.assign(seg.lines[i], { audio: `/audio/${r.name}`, dur: r.dur });
  })).then(() => {
    seg.status = 'ready';
    addLog('queue', `＋ ${seg.title} (${seg.lines.length} lines, ${segDur(seg).toFixed(0)}s)`);
  }).catch((e) => {
    seg.status = 'error'; seg.error = e.message;
    addLog('system', `⚠ "${seg.title}" failed to render: ${e.message}`);
  }).finally(pushQueue);
  if (body.wait) await job;
  return seg;
}

// ---------------------------------------------------------------- player protocol (browser)
function playerNext(client) {
  if (client !== activePlayer) return null;
  queue = queue.filter((s) => s.status !== 'error');
  const seg = queue.find((s) => s.status === 'ready' && s.station === current?.id);
  if (!seg) return null;
  if (queue[0] !== seg && queue[0]?.status === 'synth' && Date.now() - queue[0].createdAt < 20000) return null; // keep order unless the head is stuck
  queue = queue.filter((s) => s !== seg);
  seg.status = 'playing';
  onAir = { seg, line: 0, startedAt: Date.now() };
  deadAirWarned = false;
  pushQueue();
  broadcast('onair', state().onAir);
  return pub(seg);
}
function playerDone(id) {
  if (!onAir || onAir.seg.id !== id) return;
  stations.logAired(onAir.seg.station, onAir.seg);
  onAir = null;
  // Adjacent talk segments share a duck. Recover even if the tab disappears
  // before sending its delayed talking=false report.
  setTimeout(() => { if (!onAir) releaseMusic(); }, 1500).unref();
  lastAirAt = Date.now();
  broadcast('onair', null);
  pushQueue();
}
setInterval(() => {
  const s = state();
  if (s.deadAir && !deadAirWarned) { deadAirWarned = true; addLog('system', `⚠ Dead air on ${current.name}: the queue is empty`); }
}, 1000).unref();

// ---------------------------------------------------------------- wait (long-poll for Claude)
// open `radio wait` calls = Claude is listening. The tuner shows it, so a typed station never sits on a false "building…"
let waiters = 0;
const pushWatching = () => broadcast('claude', { watching: waiters > 0 });
function waitFor(q, res) {
  const timeout = Math.min(Number(q.timeout || 55), 590) * 1000;
  const started = Date.now();
  const inboxAtStart = inbox.length;
  waiters++;
  if (waiters === 1) pushWatching();
  return new Promise((resolve) => {
    let finished = false;
    const finish = () => { if (finished) return false; finished = true; clearInterval(iv); waiters--; if (!waiters) pushWatching(); return true; };
    res?.on('close', () => { if (!res.writableEnded) finish(); }); // client killed mid-wait
    const check = () => {
      const done = (reason) => { if (finish()) resolve({ reason, waitedSec: Math.round((Date.now() - started) / 1000), queuedSec: queuedSec(), inbox: inbox.slice(), station: current?.id || null }); };
      if (q.inbox !== 'ignore' && inbox.length > inboxAtStart) return done('inbox');
      if (q.for === 'low' && queuedSec() <= Number(q.seconds ?? 60)) return done('low');
      if (q.for === 'empty' && queuedSec() <= 0.5) return done('empty');
      if (q.for === 'time' && Date.now() - started >= Number(q.seconds) * 1000) return done('time');
      if (q.for === 'music' && dj.summary().nowPlaying?.remaining != null && dj.summary().nowPlaying.remaining <= Number(q.seconds ?? 30)) return done('music');
      if (Date.now() - started >= timeout) return done('timeout');
    };
    const iv = setInterval(check, 250);
    check();
  });
}

// ---------------------------------------------------------------- http
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  try {
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      const id = Math.random().toString(36).slice(2);
      clients.set(id, { res, player: q.player === '1' });
      if (q.player === '1') setTimeout(() => claimPlayer(id), 0); // after hello, so the tab knows its id
      res.write(`event: hello\ndata: ${JSON.stringify({ id, state: state(), log: log.slice(-80) })}\n\n`);
      const ka = setInterval(() => res.write(': ka\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ka); clients.delete(id);
        if (activePlayer === id) {
          activePlayer = null; // a standing-by tab can take over with "Play here"
          onAir = null;
          broadcast('onair', null);
          releaseMusic();
        }
      });
      return;
    }
    if (p === '/api/state') return send(res, 200, state());
    if (p === '/api/wait') { const r = await waitFor(q, res); return res.writableEnded || res.destroyed ? undefined : send(res, 200, r); }
    if (p === '/api/log') return send(res, 200, log.slice(-Number(q.n || 40)));

    // stations
    if (p === '/api/stations' && req.method === 'POST') {
      const st = stations.save(await readBody(req));
      addLog('system', `🛠 Station ${current?.id === st.id ? 'updated' : 'built'}: ${st.freq.toFixed(1)} ${st.name} (${st.hosts.map((h) => h.name).join(', ')})`);
      broadcast('stations', state().stations);
      if (current?.id === st.id) {
        current = st; broadcast('tune', { station: st, source: 'update' });
        musicTask(dj.setMusicEnabled(st.format !== 'talk', { resume: !!activePlayer }));
      }
      return send(res, 200, { ok: true, station: st });
    }
    if (p.startsWith('/api/stations/') && req.method === 'DELETE') {
      stations.remove(decodeURIComponent(p.split('/').pop()));
      broadcast('stations', state().stations);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/stations') return send(res, 200, stations.list());
    if (p === '/api/tune' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.prompt) {
        // a station the listener typed: Claude builds it (radio-station skill); static until then
        pending = { prompt: b.prompt, ts: Date.now() };
        current = null; queue = []; onAir = null; persist();
        broadcast('onair', null);
        musicTask(dj.setMusicEnabled(false));
        inbox.push({ ts: Date.now(), type: 'new-station', text: b.prompt });
        addLog('tune', `📡 Listener wants a new station: "${b.prompt}"`);
        broadcast('tune', { station: null, pending, source: b.source || 'ui' });
        pushQueue();
        return send(res, 200, { ok: true, pending });
      }
      const st = stations.get(b.station);
      if (!st) return send(res, 200, { ok: false, error: `no station "${b.station}"` });
      tune(st, b.source || 'cli');
      return send(res, 200, { ok: true, station: st });
    }

    // segments + queue
    if (p === '/api/segment' && req.method === 'POST') {
      const seg = await addSegment(await readBody(req));
      return send(res, 200, { ok: true, segment: pub(seg), queuedSec: queuedSec() });
    }
    if (p === '/api/queue/clear' && req.method === 'POST') { queue = []; pushQueue(); addLog('system', 'Queue cleared'); return send(res, 200, { ok: true }); }
    if (p.startsWith('/api/queue/') && req.method === 'DELETE') { const id = p.split('/').pop(); queue = queue.filter((s) => s.id !== id); pushQueue(); return send(res, 200, { ok: true }); }
    if (p === '/api/queue') return send(res, 200, { onAir: state().onAir, queue: queue.map(pub), queuedSec: queuedSec() });
    if (p === '/api/skip' && req.method === 'POST') {
      // end it here too, so status is right even if the tab is asleep; the tab's later "done" for it is ignored
      const was = onAir?.seg.title;
      if (onAir) { addLog('system', `⏭ Skipped "${was}"`); playerDone(onAir.seg.id); }
      releaseMusic();
      broadcast('skip', {}, true);
      return send(res, 200, { ok: true, skipped: was || null });
    }

    // player (browser)
    if (p === '/api/player/next' && req.method === 'POST') return send(res, 200, { segment: playerNext((await readBody(req)).client) });
    if (p === '/api/player/progress' && req.method === 'POST') {
      const b = await readBody(req);
      if (onAir && onAir.seg.id === b.id) { onAir.line = b.line; broadcast('onair', state().onAir); }
      return send(res, 200, { ok: true });
    }
    if (p === '/api/player/done' && req.method === 'POST') { playerDone((await readBody(req)).id); return send(res, 200, { ok: true }); }
    if (p === '/api/player/talking' && req.method === 'POST') {
      const b = await readBody(req);
      if (!activePlayer || b.client !== activePlayer) return send(res, 409, { ok: false, error: 'not the active player' });
      if (current && current.format !== 'talk') await dj.duck(!!b.on);
      return send(res, 200, { ok: true });
    }

    // Claude ↔ listener
    if (p === '/api/inbox' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text || '').trim().slice(0, 500);
      if (!text) return send(res, 400, { ok: false, error: 'empty' });
      inbox.push({ ts: Date.now(), type: 'request', station: current?.id || null, text });
      addLog('listener', text);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/inbox') { const items = inbox.slice(); if (q.clear) inbox.length = 0; return send(res, 200, items); }
    if (p === '/api/say' && req.method === 'POST') { addLog('claude', (await readBody(req)).text); return send(res, 200, { ok: true }); }
    if (p === '/api/notes' && req.method === 'POST') { const b = await readBody(req); stations.addNote(b.station || current?.id, b.text); return send(res, 200, { ok: true }); }
    if (p === '/api/notes') return send(res, 200, { notebook: stations.notebook(q.station || current?.id) });
    if (p === '/api/aired') return send(res, 200, stations.aired(q.station || current?.id, Number(q.n || 20)));
    if (p === '/api/voices') return send(res, 200, q.refresh || !eleven.voices.length ? await eleven.refreshVoices() : eleven.voices);
    if (p === '/api/dj/start' && req.method === 'POST') return send(res, 200, { ok: true, result: await dj.start() });

    // files
    if (p.startsWith('/audio/')) return serveFile(res, path.join(DATA, 'audio', path.basename(p)));
    const file = path.join(ROOT, 'public', p === '/' ? 'index.html' : path.normalize(p).replace(/^([/\\])+/, ''));
    if (!file.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'no');
    return serveFile(res, file);
  } catch (e) {
    return send(res, 200, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  if (current) musicTask(dj.setMusicEnabled(current.format !== 'talk', { resume: false }));
  addLog('system', `Claude Radio on http://localhost:${PORT}  ·  voices: ${eleven.fake ? 'fake (no ELEVENLABS_API_KEY or RADIO_TTS=fake)' : eleven.model}`);
  console.log(`Claude Radio listening on http://localhost:${PORT}`);
});
