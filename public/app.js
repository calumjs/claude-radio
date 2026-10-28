// Claude Radio tuner: the sound system for the hosts (Web Audio) + the dial, captions, queue and booth.
// Music comes from Claude DJ, embedded below in an iframe; the server ducks it while a host talks.
const $ = (s) => document.querySelector(s);
const post = (p, b = {}) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clean = (s) => String(s || '').replace(/\[[^\]]{1,40}\]\s*/g, '').trim();
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const FMIN = 87.5, FMAX = 108;

let S = { stations: [], queue: [], dj: {} };
let es = null;
let myId = null;             // this tab's connection id; only the claimed player tab gets segments
let powered = false;
let ctx, voiceGain, master, analyser, noiseGain;
let playing = null;          // { seg, source, aborted }
let fetching = false;
let talkOn = false, talkOffTimer = null;
const bufCache = new Map();

// ------------------------------------------------------------------ events from the server
function connect(player) {
  es?.close();
  es = new EventSource('/api/events' + (player ? '?player=1' : ''));
  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    myId = d.id;
    S = d.state;
    $('#log').innerHTML = '';
    d.log.forEach(addLog);
    renderAll();
  });
  es.addEventListener('log', (e) => addLog(JSON.parse(e.data)));
  es.addEventListener('queue', (e) => { const d = JSON.parse(e.data); S.queue = d.queue; S.queuedSec = d.queuedSec; renderQueue(); pump(); });
  es.addEventListener('tune', (e) => onTune(JSON.parse(e.data)));
  es.addEventListener('stations', (e) => { S.stations = JSON.parse(e.data); renderDial(); renderPresets(); });
  es.addEventListener('dj', (e) => { S.dj = JSON.parse(e.data); renderDJ(); });
  es.addEventListener('skip', () => stopPlayback());
  es.addEventListener('player', (e) => { if (powered && JSON.parse(e.data).active !== myId) standby(); });
  es.addEventListener('claude', (e) => { S.claude = JSON.parse(e.data); renderAll(); });
}

function onTune({ station, pending }) {
  const changed = station?.id !== S.station?.id;
  S.station = station; S.pending = pending || null;
  if (changed) { stopPlayback(); staticBurst(); $('#transcript').innerHTML = ''; renderSources([]); }
  renderAll();
}

// ------------------------------------------------------------------ audio
function initAudio() {
  ctx = new AudioContext();
  master = ctx.createGain(); master.gain.value = Number($('#volume').value);
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
  voiceGain = ctx.createGain();
  voiceGain.connect(comp).connect(master);
  master.connect(analyser); master.connect(ctx.destination);
  // tuning static: looped noise through a band-pass, like an AM/FM dial between stations
  const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const ch = nb.getChannelData(0);
  for (let i = 0; i < ch.length; i++) ch[i] = (Math.random() * 2 - 1) * 0.6;
  const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 0.6;
  noiseGain = ctx.createGain(); noiseGain.gain.value = 0;
  noise.connect(bp).connect(noiseGain).connect(master);
  noise.start();
}
function setHiss() {
  if (!noiseGain) return;
  const level = !S.station ? (S.pending ? 0.035 : 0.05) : 0;
  noiseGain.gain.setTargetAtTime(level, ctx.currentTime, 0.15);
}
function staticBurst() {
  if (!noiseGain) return;
  const t = ctx.currentTime;
  noiseGain.gain.cancelScheduledValues(t);
  noiseGain.gain.setValueAtTime(0.22, t);
  noiseGain.gain.setTargetAtTime(0, t + 0.25, 0.18);
  setTimeout(setHiss, 900);
}
function loadBuf(url) {
  if (!bufCache.has(url)) {
    bufCache.set(url, fetch(url).then((r) => r.arrayBuffer()).then((b) => ctx.decodeAudioData(b)));
    if (bufCache.size > 80) bufCache.delete(bufCache.keys().next().value);
  }
  return bufCache.get(url);
}
function playBuf(run, buf) {
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(voiceGain);
    src.onended = resolve;
    run.source = src;
    src.start();
  });
}
/** tell the server a host is talking (it ducks the DJ); the release waits a beat so back-to-back segments don't pump */
function setTalk(on) {
  clearTimeout(talkOffTimer);
  if (on && !talkOn) { talkOn = true; post('/api/player/talking', { on: true }); }
  if (!on && talkOn) talkOffTimer = setTimeout(() => { talkOn = false; post('/api/player/talking', { on: false }); }, 1200);
}

// ------------------------------------------------------------------ the player loop
async function pump() {
  if (!powered || playing || fetching || !S.station) return;
  fetching = true;
  try { const r = await post('/api/player/next', { client: myId }); if (r.segment) playSegment(r.segment); }
  catch { /* server restarting */ }
  finally { fetching = false; }
}
setInterval(pump, 1500);

async function playSegment(seg) {
  const run = { seg, aborted: false, source: null };
  playing = run;
  document.body.classList.add('live');
  $('#segTitle').textContent = seg.title;
  renderSources(seg.sources);
  const t = document.createElement('div'); t.className = 'seg'; t.textContent = seg.title; $('#transcript').append(t);
  const bufs = seg.lines.map((l) => loadBuf(l.audio));
  bufs.forEach((p) => p.catch(() => {}));
  const talk = seg.duck && seg.kind !== 'ident';
  if (talk) { const wasOn = talkOn; setTalk(true); if (!wasOn && S.station?.format !== 'talk') await sleep(400); }
  for (let i = 0; i < seg.lines.length && !run.aborted; i++) {
    const l = seg.lines[i];
    post('/api/player/progress', { id: seg.id, line: i }).catch(() => {});
    let buf;
    try { buf = await bufs[i]; } catch (e) { console.warn('[radio] line failed to load', l.audio, e); continue; }
    if (run.aborted) break;
    showLine(l);
    await playBuf(run, buf);
    setSpeaking(null);
    if (i < seg.lines.length - 1 && l.host !== 'SFX' && !run.aborted) await sleep(160);
  }
  if (talk) setTalk(false);
  setSpeaking(null);
  if (run.aborted) showLine(null); // skipped: don't leave the cut-off line up as if it's still on air
  post('/api/player/done', { id: seg.id }).catch(() => {});
  if (playing === run) playing = null;
  document.body.classList.toggle('live', !!playing);
  renderSignal();
  pump();
}
function stopPlayback() {
  if (!playing) return;
  playing.aborted = true;
  try { playing.source?.stop(); } catch { /* not started */ }
}

// ------------------------------------------------------------------ rendering
function renderAll() {
  const st = S.station;
  document.body.classList.toggle('pending', !st && !!S.pending);
  $('#freq').textContent = st ? st.freq.toFixed(1) : '--.-';
  $('#stationName').textContent = st ? st.name : S.pending ? 'Tuning in…' : 'Static';
  const watching = !!S.claude?.watching;
  $('#stationTagline').textContent = st ? st.tagline
    : S.pending ? (watching ? `Claude is building “${S.pending.prompt}”: researching, casting hosts, writing the first segment.`
      : `“${S.pending.prompt}” is waiting, but Claude isn't listening right now. In Claude Code (in AI_Radio), say "run the radio".`)
    : 'Turn the dial, or type the station you want.';
  $('#voiceStatus .txt').textContent = S.tts || '';
  $('#claudeStatus').className = 'status ' + (watching ? 'on' : 'warn');
  $('#claudeStatus .txt').textContent = watching ? 'Claude listening' : 'Claude away';
  $('#claudeStatus').title = watching ? 'Claude is watching the inbox and the queue' : 'No radio wait is open: requests and typed stations queue until Claude is running the station in Claude Code';
  if (!st) { $('#segTitle').textContent = '—'; showLine(null); }
  renderHosts(); renderDial(); renderPresets(); renderQueue(); renderDJ(); renderSignal(); setHiss();
}
function renderSignal() {
  $('#signal').className = 'signal ' + (!S.station ? 's1' : playing ? 's5' : 's3');
}
function renderHosts() {
  const hosts = S.station?.hosts || [];
  $('#hosts').innerHTML = hosts.map((h) => `<div class="host" data-host="${esc(h.name)}" style="--c:${h.color}"><div class="av">${esc(h.name.slice(0, 1).toUpperCase())}</div><div><div class="nm">${esc(h.name)}</div><div class="rl">${esc(h.role)} · ${esc(h.voice)}</div></div><div class="bars"><i></i><i></i><i></i><i></i></div></div>`).join('');
}
function setSpeaking(name) {
  for (const el of document.querySelectorAll('.host')) el.classList.toggle('talking', el.dataset.host === name);
}
let speakingColor = '#ff7a45';
function showLine(l) {
  if (!l) { $('#caption .who').textContent = ''; $('#caption .said').textContent = powered ? (S.station ? 'Waiting for the next segment…' : '') : 'Power on to listen.'; return; }
  const h = S.station?.hosts.find((x) => x.name === l.host);
  speakingColor = h?.color || '#e8a17f';
  document.documentElement.style.setProperty('--host', speakingColor);
  setSpeaking(l.host);
  if (l.host === 'SFX') return;
  $('#caption .who').textContent = l.host;
  $('#caption .said').textContent = clean(l.text);
  const d = document.createElement('div'); d.className = 'l';
  d.innerHTML = `<b style="color:${speakingColor}">${esc(l.host)}</b>${esc(clean(l.text))}`;
  const tr = $('#transcript'); tr.append(d);
  while (tr.children.length > 120) tr.firstChild.remove();
  tr.scrollTop = tr.scrollHeight;
}
function renderSources(src) {
  $('#sources').innerHTML = src?.length ? src.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a></li>`).join('') : '<li class="empty">Sources for what the hosts say show up here.</li>';
}
function renderQueue() {
  $('#queuedSec').textContent = S.queuedSec ? `${mmss(S.queuedSec)} queued` : '';
  $('#queue').innerHTML = S.queue?.length
    ? S.queue.map((s) => `<li><span class="st ${s.status}">${s.status === 'synth' ? 'voicing' : s.status}</span><span class="t" title="${esc(s.error || '')}">${esc(s.title)}</span><span class="d">${mmss(s.dur)}</span></li>`).join('')
    : `<li class="empty">${S.station ? 'Claude is writing the next segment…' : 'Nothing queued.'}</li>`;
}
function renderPresets() {
  $('#presets').innerHTML = (S.stations || []).map((s) => `<button class="preset${S.station?.id === s.id ? ' on' : ''}" data-id="${esc(s.id)}" title="${esc(s.tagline)}"><b>${s.freq.toFixed(1)}</b>${esc(s.name)}<span class="fmt">${s.format}</span></button>`).join('');
}
function addLog(e) {
  const d = document.createElement('div');
  d.className = `e ${e.kind}`;
  d.innerHTML = `<span class="ts">${new Date(e.ts).toTimeString().slice(0, 5)}</span>${esc(e.text)}`;
  const box = $('#log'); box.append(d);
  while (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------------ music (Claude DJ)
let djUserOpen = false;
function renderDJ() {
  const music = S.station && S.station.format !== 'talk';
  const d = S.dj || {};
  $('#music').hidden = !music;
  $('#djStatus').hidden = !music;
  $('#djStatus').className = 'status ' + (d.reachable && d.engine ? 'on' : d.reachable ? 'warn' : '');
  $('#djStatus .txt').textContent = !d.reachable ? 'DJ offline' : d.engine ? (d.ducked ? 'DJ ducked' : 'DJ live') : 'DJ engine off';
  if (!music) return;
  const ifr = $('#djIframe');
  if (d.reachable && !ifr.src) ifr.src = d.url;
  const needStart = d.reachable && !d.engine;
  $('#djFrame').classList.toggle('needstart', needStart);
  $('#djFrame').classList.toggle('collapsed', !needStart && !djUserOpen);
  $('#djToggle').textContent = djUserOpen ? 'HIDE DECKS' : 'SHOW DECKS';
  const np = d.nowPlaying;
  $('#nowPlaying').textContent = !d.reachable ? 'Claude DJ is starting…' : np ? `♪ ${np.artist ? np.artist + ' – ' : ''}${np.title}  ·  ${np.bpm ?? '?'} BPM ${np.camelot ?? ''}  ·  ${np.remaining != null ? mmss(np.remaining) + ' left' : ''}` : 'No track playing';
}
$('#djToggle').onclick = () => { djUserOpen = !djUserOpen; renderDJ(); };

// ------------------------------------------------------------------ the dial
const fx = (f, w) => ((f - FMIN) / (FMAX - FMIN)) * w;
const xf = (x, w) => FMIN + (x / w) * (FMAX - FMIN);
let previewFreq = null;
function renderDial() {
  const cv = $('#dialCanvas'), dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = 96;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const pad = 18, iw = w - pad * 2;
  g.font = '11px JetBrains Mono, monospace'; g.textAlign = 'center';
  for (let f = 88; f <= 108.001; f += 0.2) {
    const x = pad + fx(f, iw), whole = Math.abs(f - Math.round(f)) < 0.01, even = whole && Math.round(f) % 2 === 0;
    g.strokeStyle = even ? '#f2b45acc' : whole ? '#f2b45a77' : '#f2b45a33';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(x, 40); g.lineTo(x, 40 + (even ? 18 : whole ? 12 : 6)); g.stroke();
    if (even) { g.fillStyle = '#f2b45a99'; g.fillText(String(Math.round(f)), x, 74); }
  }
  // station markers: alternate label rows so close stations don't collide
  (S.stations || []).forEach((s, i) => {
    const x = pad + fx(s.freq, iw), on = S.station?.id === s.id;
    g.fillStyle = on ? '#ff7a45' : '#f2b45a';
    g.beginPath(); g.moveTo(x - 4, 30); g.lineTo(x + 4, 30); g.lineTo(x, 37); g.fill();
    g.fillStyle = on ? '#ecebf2' : '#8a8998';
    g.font = `${on ? 600 : 400} 11px Space Grotesk, sans-serif`;
    g.fillText(s.name.length > 16 ? s.name.slice(0, 15) + '…' : s.name, x, i % 2 ? 26 : 14);
  });
  g.fillStyle = '#55546a'; g.font = '10px JetBrains Mono, monospace'; g.textAlign = 'right';
  g.fillText('MHz', w - 6, 90);
  const f = previewFreq ?? S.station?.freq;
  const needle = $('#needle');
  needle.style.display = f ? 'block' : 'none';
  if (f) needle.style.left = `${((pad + fx(f, iw)) / w) * 100}%`;
}
addEventListener('resize', renderDial);
function nearestStation(f) {
  let best = null;
  for (const s of S.stations || []) if (!best || Math.abs(s.freq - f) < Math.abs(best.freq - f)) best = s;
  return best;
}
function tuneTo(id) { if (id && id !== S.station?.id) post('/api/tune', { station: id, source: 'ui' }); }
(() => {
  const dial = $('#dial');
  const freqAt = (e) => { const r = dial.getBoundingClientRect(); const pad = 18; return Math.min(FMAX, Math.max(FMIN, xf(e.clientX - r.left - pad, r.width - pad * 2))); };
  let drag = false;
  dial.addEventListener('pointerdown', (e) => { drag = true; dial.setPointerCapture(e.pointerId); dial.classList.add('dragging'); move(e); });
  dial.addEventListener('pointermove', (e) => drag && move(e));
  dial.addEventListener('pointerup', (e) => {
    if (!drag) return;
    drag = false; dial.classList.remove('dragging');
    const s = nearestStation(freqAt(e));
    previewFreq = null;
    if (s) { tuneTo(s.id); if (s.id === S.station?.id) renderDial(); }
  });
  function move(e) {
    previewFreq = freqAt(e);
    $('#freq').textContent = previewFreq.toFixed(1);
    const s = nearestStation(previewFreq);
    if (noiseGain && (!s || Math.abs(s.freq - previewFreq) > 0.15)) noiseGain.gain.setTargetAtTime(0.12, ctx.currentTime, 0.03);
    else setHiss();
    renderDial();
  }
  dial.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = S.stations || [];
    const i = list.findIndex((s) => s.id === S.station?.id);
    const n = list[(i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    if (n) tuneTo(n.id);
    e.preventDefault();
  });
})();
$('#presets').addEventListener('click', (e) => { const b = e.target.closest('.preset'); if (b) tuneTo(b.dataset.id); });
$('#customForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#customInput').value.trim();
  if (!text) return;
  post('/api/tune', { prompt: text, source: 'ui' });
  $('#customInput').value = '';
});
$('#askForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#askInput').value.trim();
  if (!text) return;
  post('/api/inbox', { text });
  $('#askInput').value = '';
});
$('#skipBtn').onclick = () => stopPlayback();
$('#volume').oninput = (e) => master && master.gain.setTargetAtTime(Number(e.target.value), ctx.currentTime, 0.05);

// ------------------------------------------------------------------ scope
function drawScope() {
  requestAnimationFrame(drawScope);
  const cv = $('#scope'), w = cv.clientWidth, h = 70, dpr = devicePixelRatio || 1;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (!analyser) return;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const bars = Math.min(96, Math.floor(w / 6)), bw = w / bars;
  g.fillStyle = speakingColor;
  for (let i = 0; i < bars; i++) {
    const v = data[Math.floor((i / bars) ** 1.6 * data.length * 0.55)] / 255;
    const bh = Math.max(1, v * h * 0.95);
    g.globalAlpha = 0.25 + v * 0.75;
    g.fillRect(i * bw + 1, (h - bh) / 2, bw - 2, bh);
  }
  g.globalAlpha = 1;
}
drawScope();

// ------------------------------------------------------------------ power
/** another tab took over playback: go quiet and offer to take it back */
function standby() {
  stopPlayback();
  setTalk(false);
  powered = false;
  $('#powerStatus').className = 'status warn';
  $('#powerStatus .txt').textContent = 'playing in another tab';
  $('#overlayTitle').textContent = 'Playing in another tab';
  $('#overlayMsg').textContent = 'Claude Radio plays in one tab at a time. Take it back here?';
  $('#powerBtn').textContent = 'PLAY HERE';
  $('#powerOverlay').classList.remove('hide');
  connect(false);
}
$('#powerBtn').onclick = async () => {
  if (!ctx) initAudio();
  await ctx.resume();
  powered = true;
  $('#powerOverlay').classList.add('hide');
  $('#powerStatus').className = 'status on';
  $('#powerStatus .txt').textContent = 'listening';
  connect(true);
  showLine(null);
};
connect(false);
