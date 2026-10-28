// Bridge to Claude DJ (the `dj` submodule, or any running Claude DJ server). The radio never plays
// music itself: the DJ engine does, embedded in the tuner page. The bridge watches the DJ's state for the
// now-playing card and dips the DJ master while a host talks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const STATION_PAUSE = 'Radio: pausing the DJ set for talk radio';

// The DJ CLI and server use DJ_PORT. Keep them on the same endpoint as the bridge,
// including when Radio uses a non-default port or an existing local installation.
export function djEnvironment(url, env = process.env) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
      || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
    throw new Error('Starting DJ and running its CLI requires a local HTTP DJ URL (localhost, 127.0.0.1 or [::1])');
  }
  return { ...env, DJ_PORT: endpoint.port || '80' };
}

export class DJBridge {
  #operations = Promise.resolve();

  #serial(fn) {
    const job = this.#operations.then(fn);
    this.#operations = job.catch(() => {});
    return job;
  }
  constructor({ dir, url, duckLevel = 0.3, log = () => {}, onState = () => {} }) {
    this.dir = dir;
    this.url = url.replace(/\/$/, '');
    this.duckLevel = duckLevel;
    this.log = log;
    this.onState = onState;
    this.state = null;
    this.reachable = false;
    this.ducked = null; // master volume before the duck
    this.restoring = null; // target of an unfinished release ramp
    this.musicEnabled = null;
    this.suspended = null; // only transport state paused by a station switch, never persisted
  }

  get installed() { return fs.existsSync(path.join(this.dir, 'dj.mjs')); }

  async api(p, body) {
    const r = await fetch(this.url + p, { signal: AbortSignal.timeout(body ? 12000 : 2500), ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!r.ok) throw new Error(`Claude DJ returned HTTP ${r.status}`);
    const result = await r.json();
    if (result?.ok === false) throw new Error(result.error || 'Claude DJ command failed');
    return result;
  }

  async poll() {
    try { this.state = await this.api('/api/state'); this.reachable = true; } catch { this.state = null; this.reachable = false; }
    this.onState(this.summary());
  }

  summary() {
    const s = this.state;
    if (!this.reachable || !s) return { reachable: false, installed: this.installed, url: this.url, enabled: this.musicEnabled };
    const live = s.live ? s.decks?.[s.live] : null;
    return {
      reachable: true, installed: this.installed, url: this.url,
      enabled: this.musicEnabled,
      engine: !!s.engine?.connected,
      master: s.master?.volume ?? null,
      ducked: this.ducked != null,
      nowPlaying: live ? { title: live.title, artist: live.artist, bpm: live.bpm ? +(live.bpm * (live.rate || 1)).toFixed(1) : null, camelot: live.camelot, remaining: live.remaining, deck: s.live } : null,
      transition: s.transition ? { from: s.transition.from, to: s.transition.to, style: s.transition.style } : null,
    };
  }

  /** start the DJ server in the background if it isn't up (no browser tab: the tuner embeds it) */
  async start() {
    await this.poll();
    if (this.reachable) return 'already running';
    if (!this.installed) throw new Error(`Claude DJ not found at ${this.dir} (git submodule update --init, or set dj.dir in config.local.json)`);
    const child = spawn(process.execPath, [path.join(this.dir, 'dj.mjs'), 'start', '--no-open'], { cwd: this.dir, env: djEnvironment(this.url), detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', (e) => this.log(`Claude DJ failed to start: ${e.message}`));
    child.unref();
    for (let i = 0; i < 40 && !this.reachable; i++) { await new Promise((r) => setTimeout(r, 300)); await this.poll(); }
    if (!this.reachable) throw new Error('Claude DJ server did not come up (see its .dj/server.log)');
    return 'started';
  }

  /** master volume with a ramp in beats (DJ builds without master ramps just jump, which still works) */
  async #master(v, beats, why) { return this.api('/api/cmd', { cmd: 'master', args: { value: +v.toFixed(3), ramp: beats }, source: 'radio', why }); }

  async #restore(beats) {
    const base = this.ducked;
    await this.#master(base, beats);
    const live = this.state?.decks?.[this.state?.live];
    const bpm = (live?.bpm || 120) * (live?.rate || 1);
    this.restoring = { base, until: Date.now() + beats * 60000 / bpm + 100 };
    this.ducked = null;
  }

  duck(on) { return this.#serial(async () => {
    if (on && this.musicEnabled === false) return;
    if (!this.reachable || !this.state?.engine?.connected) return;
    if (on && this.ducked == null) {
      await this.poll(); // capture the current master, not a value from before a knob change
      if (!this.reachable || !this.state?.engine?.connected) return;
      // A new break can interrupt the release ramp. Reuse its target so repeated
      // breaks cannot ratchet the music quieter by sampling halfway up the ramp.
      const base = this.restoring?.until > Date.now() ? this.restoring.base : this.state.master?.volume ?? 0.9;
      await this.#master(base * this.duckLevel, 1);
      this.ducked = base;
      this.restoring = null;
    } else if (!on && this.ducked != null) {
      await this.#restore(2);
    }
  }); }

  /** Talk stations suspend the set. Returning to music resumes only untouched
   * decks we paused, with a listener present. Loaded-but-paused decks stay paused.
   * A zero master also keeps already scheduled deck starts silent during talk. */
  setMusicEnabled(on, { resume = true } = {}) { return this.#serial(async () => {
    const wasEnabled = this.musicEnabled;
    this.musicEnabled = on;
    if (on) await this.start();
    else await this.poll();
    if (!this.reachable || !this.state?.engine?.connected) return;

    if (!on) {
      // Talk -> talk must keep the original snapshot, including an empty one.
      if (wasEnabled === false && this.suspended) return;
      const decks = Object.fromEntries(Object.entries(this.state.decks || {}).filter(([, d]) => d.playing));
      const volume = this.ducked ?? (this.restoring?.until > Date.now() ? this.restoring.base : this.state.master?.volume ?? 0.9);
      this.suspended = { decks: {}, volume, checkpoint: null };
      // Start watching intent BEFORE pausing: a user's stop can arrive while
      // Web Audio is confirming our pause. Mark only our own synchronous log pair.
      try { this.suspended.checkpoint = await this.api('/api/log?n=300'); } catch { /* fail closed on resume */ }
      const resumable = new Set(Object.keys(decks));
      for (const deck of resumable) {
        const last = this.suspended.checkpoint?.filter((e) => e.kind === 'action' && /^(play|pause|cue)\s+deck=([A-D])\b/i.exec(e.text)?.[2] === deck).at(-1);
        if (last && /^(pause|cue)\b/i.test(last.text)) resumable.delete(deck);
      }
      await this.#master(0, 0, STATION_PAUSE);
      this.ducked = null; this.restoring = null;
      for (const deck of Object.keys(decks)) await this.api('/api/cmd', { cmd: 'pause', args: { deck }, source: 'radio', why: STATION_PAUSE });
      // Web Audio schedules pause a few milliseconds ahead. The command ACK can
      // still say playing=true; wait for telemetry before recording the position.
      const paused = () => this.reachable && Object.keys(decks).every((deck) => !this.state?.decks?.[deck]?.playing);
      for (let i = 0; i < 30; i++) {
        await this.poll();
        if (paused()) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!paused()) throw new Error('DJ engine did not confirm paused decks; the set remains muted');
      for (const [deck, before] of Object.entries(decks)) {
        const paused = this.state?.decks?.[deck];
        if (resumable.has(deck) && paused && !paused.playing && paused.trackId === before.trackId) this.suspended.decks[deck] = { trackId: paused.trackId, position: paused.position };
      }
    } else if (this.suspended) {
      const suspended = this.suspended;
      // Consume once. A failed or uncertain play must never be retried by tuning again.
      this.suspended = null;
      let changed = null;
      try {
        const logs = await this.api('/api/log?n=300');
        const key = (e) => JSON.stringify(e);
        const last = suspended.checkpoint?.at(-1);
        const at = last ? logs.findLastIndex((e) => key(e) === key(last)) : -1;
        if (at >= 0) {
          const since = logs.slice(at + 1);
          changed = since.filter((e, i) => !(e.kind === 'action' && since[i - 1]?.kind === 'claude' && since[i - 1].text === STATION_PAUSE));
        }
      } catch { /* no history: fail closed on resume */ }
      const transportChanged = changed == null || changed.some((e) =>
        (e.kind === 'action' && /^(pause|play|cue|seek|Load |Mix |perform|Hot cue|Saved loop)/i.test(e.text))
        || (e.kind === 'system' && /Audio engine online/.test(e.text)));
      const masterChanged = changed == null || changed.some((e) => e.kind === 'action' && /^master\b/i.test(e.text));
      const candidates = resume && !transportChanged && !masterChanged && this.state.master?.volume === 0 ? Object.entries(suspended.decks).filter(([deck, before]) => {
        const now = this.state.decks?.[deck];
        return now && !now.playing && now.trackId === before.trackId && Math.abs(now.position - before.position) < 0.005;
      }) : [];
      // A planned/external start during talk is not an instruction to resume it.
      for (const [deck, d] of Object.entries(this.state.decks || {})) if (d.playing) await this.api('/api/cmd', { cmd: 'pause', args: { deck }, source: 'radio' });
      if (!masterChanged && this.state.master?.volume === 0) {
        await this.#master(suspended.volume, 2);
        this.restoring = { base: suspended.volume, until: Date.now() + 1200 };
      }
      for (const [deck] of candidates) await this.api('/api/cmd', { cmd: 'play', args: { deck }, source: 'radio' });
      await this.poll();
    }
    this.onState(this.summary());
  }); }

  /** silence the decks (tuned away to a talk station) */
  pauseAll() { return this.#serial(async () => {
    await this.poll();
    if (!this.reachable) return;
    for (const [deck, d] of Object.entries(this.state?.decks || {})) if (d.playing) await this.api('/api/cmd', { cmd: 'pause', args: { deck }, source: 'radio' });
    if (this.ducked != null) await this.#restore(1);
  }); }

  /** run the DJ CLI (dj.mjs) with these args; resolves with its output */
  cli(args) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(this.dir, 'dj.mjs'), ...args], { cwd: this.dir, env: djEnvironment(this.url), windowsHide: true });
      let out = '';
      p.on('error', reject);
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out }));
    });
  }
}
