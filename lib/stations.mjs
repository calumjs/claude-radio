// Stations: presets in stations/*.json (checked in) + custom stations Claude builds from a prompt in
// .radio/stations/<id>.json. Each station also keeps a notebook (what's been covered, running bits,
// leads to chase) and an aired log, so the hosts never repeat themselves across sessions.
import fs from 'node:fs';
import path from 'node:path';

const HOST_COLORS = ['#ff7a45', '#36d6e7', '#c792ea', '#9be564', '#f2cc60', '#ff6b9d'];
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'station';

export class Stations {
  constructor({ presetDir, dataDir }) {
    this.presetDir = presetDir;
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.reload();
  }

  reload() {
    this.map = new Map();
    for (const [dir, custom] of [[this.presetDir, false], [this.dataDir, true]]) {
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!f.endsWith('.json')) continue;
        try { const s = normalise(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), custom); this.map.set(s.id, s); } catch { /* skip a broken file */ }
      }
    }
  }

  list() { return [...this.map.values()].sort((a, b) => a.freq - b.freq); }

  /** id, frequency ("97.5"), or a name fragment */
  get(q) {
    if (q == null) return null;
    if (this.map.has(q)) return this.map.get(q);
    const f = Number(q);
    if (!isNaN(f)) return this.list().find((s) => Math.abs(s.freq - f) < 0.05) || null;
    const l = String(q).toLowerCase();
    return this.list().find((s) => s.name.toLowerCase() === l) || this.list().find((s) => s.name.toLowerCase().includes(l) || s.id.includes(slug(l))) || null;
  }

  /** a free frequency for a new station, away from existing ones */
  freeFreq() {
    const used = this.list().map((s) => s.freq);
    for (let tries = 0; tries < 200; tries++) {
      const f = +(88.1 + Math.floor(Math.random() * 100) * 0.2).toFixed(1);
      if (f <= 107.9 && used.every((u) => Math.abs(u - f) >= 0.8)) return f;
    }
    return 107.9;
  }

  save(def) {
    const s = normalise({ ...def, freq: def.freq ?? this.freeFreq() }, true);
    if (this.map.has(s.id) && !this.map.get(s.id).custom && !def.overwrite) throw new Error(`"${s.id}" is a preset; pick another id`);
    fs.writeFileSync(path.join(this.dataDir, `${s.id}.json`), JSON.stringify(s, null, 2));
    this.map.set(s.id, s);
    return s;
  }

  remove(id) {
    const s = this.map.get(id);
    if (!s?.custom) throw new Error(`no custom station "${id}"`);
    fs.rmSync(path.join(this.dataDir, `${id}.json`), { force: true });
    this.map.delete(id);
  }

  dir(id) { const d = path.join(this.dataDir, id); fs.mkdirSync(d, { recursive: true }); return d; }
  notebook(id) { try { return fs.readFileSync(path.join(this.dir(id), 'notebook.md'), 'utf8'); } catch { return ''; } }
  addNote(id, text) {
    fs.appendFileSync(path.join(this.dir(id), 'notebook.md'), `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')}  ${text.trim()}\n`);
  }
  logAired(id, seg) {
    fs.appendFileSync(path.join(this.dir(id), 'aired.jsonl'), JSON.stringify({ ts: Date.now(), title: seg.title, kind: seg.kind, lines: seg.lines.map((l) => `${l.host}: ${l.text}`), sources: seg.sources }) + '\n');
  }
  aired(id, n = 20) {
    try { return fs.readFileSync(path.join(this.dir(id), 'aired.jsonl'), 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
  }
}

function normalise(s, custom) {
  if (!s.name) throw new Error('station needs a name');
  const hosts = (s.hosts || []).map((h, i) => ({ role: 'host', persona: '', color: HOST_COLORS[i % HOST_COLORS.length], ...h, key: slug(h.name) }));
  if (!hosts.length) throw new Error('station needs at least one host');
  return {
    id: s.id ? slug(s.id) : slug(s.name),
    name: s.name,
    freq: +Number(s.freq).toFixed(1),
    tagline: s.tagline || '',
    format: ['talk', 'music', 'mixed'].includes(s.format) ? s.format : 'talk',
    brief: s.brief || '',
    clock: s.clock || [],
    music: s.music || null,
    hosts,
    prompt: s.prompt || null,
    custom,
    createdAt: s.createdAt || Date.now(),
  };
}
