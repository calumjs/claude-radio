// Bridge to Claude DJ (the `dj` submodule, or any running Claude DJ server). The radio never plays
// music itself: the DJ engine does, embedded in the tuner page. The bridge watches the DJ's state for the
// now-playing card and dips the DJ master while a host talks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class DJBridge {
  constructor({ dir, url, duckLevel = 0.3, log = () => {}, onState = () => {} }) {
    this.dir = dir;
    this.url = url.replace(/\/$/, '');
    this.duckLevel = duckLevel;
    this.log = log;
    this.onState = onState;
    this.state = null;
    this.reachable = false;
    this.ducked = null; // master volume before the duck
  }

  get installed() { return fs.existsSync(path.join(this.dir, 'dj.mjs')); }

  async api(p, body) {
    const r = await fetch(this.url + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { signal: AbortSignal.timeout(2500) });
    return r.json();
  }

  async poll() {
    try { this.state = await this.api('/api/state'); this.reachable = true; } catch { this.state = null; this.reachable = false; }
    this.onState(this.summary());
  }

  summary() {
    const s = this.state;
    if (!this.reachable || !s) return { reachable: false, installed: this.installed, url: this.url };
    const live = s.live ? s.decks?.[s.live] : null;
    return {
      reachable: true, installed: this.installed, url: this.url,
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
    const child = spawn(process.execPath, [path.join(this.dir, 'dj.mjs'), 'start', '--no-open'], { cwd: this.dir, detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    for (let i = 0; i < 40 && !this.reachable; i++) { await new Promise((r) => setTimeout(r, 300)); await this.poll(); }
    if (!this.reachable) throw new Error('Claude DJ server did not come up (see its .dj/server.log)');
    return 'started';
  }

  /** master volume with a ramp in beats (DJ builds without master ramps just jump, which still works) */
  async #master(v, beats) { return this.api('/api/cmd', { cmd: 'master', args: { value: +v.toFixed(3), ramp: beats }, source: 'radio' }).catch(() => null); }

  async duck(on) {
    if (!this.reachable || !this.state?.engine?.connected) return;
    if (on && this.ducked == null) {
      const base = this.state.master?.volume ?? 0.9;
      this.ducked = base;
      await this.#master(base * this.duckLevel, 1);
    } else if (!on && this.ducked != null) {
      const base = this.ducked;
      this.ducked = null;
      await this.#master(base, 2);
    }
  }

  /** silence the decks (tuned away to a talk station) */
  async pauseAll() {
    if (!this.reachable) return;
    for (const [deck, d] of Object.entries(this.state?.decks || {})) if (d.playing) await this.api('/api/cmd', { cmd: 'pause', args: { deck }, source: 'radio' }).catch(() => null);
    if (this.ducked != null) { await this.#master(this.ducked, 1); this.ducked = null; }
  }

  /** run the DJ CLI (dj.mjs) with these args; resolves with its output */
  cli(args) {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(this.dir, 'dj.mjs'), ...args], { cwd: this.dir, windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out }));
    });
  }
}
