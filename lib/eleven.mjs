// ElevenLabs client: voices, text-to-speech, sound effects. Every render is cached by content hash
// in .radio/audio so a re-run of the same line costs nothing. RADIO_TTS=fake renders silent WAVs
// (length ~ words / 2.6 s) so tests and offline runs never spend credits.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const API = 'https://api.elevenlabs.io/v1';
const TAG = /\[[^\]]{1,40}\]\s*/g; // v3 audio tags: [laughs] [whispers] [excited] …

export class Eleven {
  constructor({ dir, model = 'eleven_v4', fallbackModel = 'eleven_v3', outputFormat = 'mp3_44100_128', voiceSettings = null, concurrency = 3, log = () => {} }) {
    this.dir = dir;
    this.model = model;
    this.fallbackModel = fallbackModel;
    this.outputFormat = outputFormat;
    this.kbps = Number(outputFormat.split("_")[2]) || 128;
    this.voiceSettings = voiceSettings;
    this.log = log;
    this.concurrency = concurrency;
    this.active = 0;
    this.waiting = [];
    this.fake = process.env.RADIO_TTS === 'fake' || !process.env.ELEVENLABS_API_KEY;
    this.voicesFile = path.join(dir, '..', 'voices.json');
    this.voices = [];
    fs.mkdirSync(dir, { recursive: true });
    try { this.voices = JSON.parse(fs.readFileSync(this.voicesFile, 'utf8')); } catch { /* fetched on demand */ }
  }

  get key() { return process.env.ELEVENLABS_API_KEY; }

  async refreshVoices() {
    if (this.fake) return this.voices;
    const r = await fetch(`${API}/voices`, { headers: { 'xi-api-key': this.key } });
    if (!r.ok) throw new Error(`voices: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    this.voices = j.voices.map((v) => ({
      id: v.voice_id,
      name: v.name.split(/\s+-\s+/)[0].trim(),
      fullName: v.name,
      category: v.category,
      labels: v.labels || {},
      description: v.description || '',
      preview: v.preview_url || null,
    }));
    fs.writeFileSync(this.voicesFile, JSON.stringify(this.voices, null, 2));
    return this.voices;
  }

  /** a voice id, a short name ("George") or a full name ("George - Warm, …") → voice id */
  async resolveVoice(v) {
    if (!v) throw new Error('no voice given');
    if (/^[A-Za-z0-9]{20}$/.test(v)) return v;
    if (!this.voices.length) await this.refreshVoices().catch(() => {});
    const q = String(v).toLowerCase();
    const hit = this.voices.find((x) => x.name.toLowerCase() === q) || this.voices.find((x) => x.fullName.toLowerCase() === q) || this.voices.find((x) => x.fullName.toLowerCase().startsWith(q));
    if (hit) return hit.id;
    if (this.fake) return 'fake' + crypto.createHash('md5').update(q).digest('hex').slice(0, 16);
    throw new Error(`no ElevenLabs voice called "${v}" (node radio.mjs voices)`);
  }

  /** text → { file, url, dur }  (cached) */
  async tts(voiceId, text, { model = this.model } = {}) {
    const spoken = /^eleven_v[34]/.test(model) ? text : text.replace(TAG, ''); // v3/v4 perform audio tags; older models would read them out
    const ext = this.fake ? 'wav' : 'mp3';
    const hash = crypto.createHash('sha1').update([model, voiceId, this.outputFormat, JSON.stringify(this.voiceSettings), spoken].join('|')).digest('hex').slice(0, 20);
    const file = path.join(this.dir, `${hash}.${ext}`);
    if (!fs.existsSync(file)) {
      const buf = this.fake ? silentWav(estimateSec(spoken)) : await this.#render(voiceId, spoken, model);
      fs.writeFileSync(file + '.part', buf);
      fs.renameSync(file + '.part', file);
    }
    return { file, name: path.basename(file), dur: audioSeconds(file, this.kbps) };
  }

  async #render(voiceId, text, model) {
    const body = { text, model_id: model };
    if (this.voiceSettings) body.voice_settings = this.voiceSettings;
    const r = await this.#post(`${API}/text-to-speech/${voiceId}?output_format=${this.outputFormat}`, body);
    if (!r.ok && model !== this.fallbackModel && r.status !== 401 && r.status !== 429) {
      this.log(`TTS ${model} failed (HTTP ${r.status}); retrying with ${this.fallbackModel}`);
      return this.#render(voiceId, /^eleven_v[34]/.test(this.fallbackModel) ? text : text.replace(TAG, ''), this.fallbackModel);
    }
    if (!r.ok) throw new Error(`TTS HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** POST through a small semaphore (plans cap concurrent requests, e.g. 5) and retry rate limits with backoff */
  async #post(url, body) {
    while (this.active >= this.concurrency) await new Promise((r) => this.waiting.push(r));
    this.active++;
    try {
      for (let attempt = 0; ; attempt++) {
        const r = await fetch(url, { method: 'POST', headers: { 'xi-api-key': this.key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (r.status !== 429 || attempt >= 6) return r;
        await r.text();
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  /** sound effect / station ident from a prompt → { file, dur } */
  async sfx(prompt, seconds = 4) {
    const hash = crypto.createHash('sha1').update(`sfx|${seconds}|${prompt}`).digest('hex').slice(0, 20);
    const file = path.join(this.dir, `sfx-${hash}.${this.fake ? 'wav' : 'mp3'}`);
    if (!fs.existsSync(file)) {
      let buf;
      if (this.fake) buf = silentWav(seconds);
      else {
        const r = await this.#post(`${API}/sound-generation?output_format=${this.outputFormat}`, { text: prompt, duration_seconds: Math.max(0.5, Math.min(22, seconds)), prompt_influence: 0.5 });
        if (!r.ok) throw new Error(`sound-generation HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
        buf = Buffer.from(await r.arrayBuffer());
      }
      fs.writeFileSync(file, buf);
    }
    return { file, name: path.basename(file), dur: audioSeconds(file, this.kbps) };
  }
}

export const stripTags = (s) => s.replace(TAG, '').trim();
export const estimateSec = (text) => Math.max(1, stripTags(text).split(/\s+/).filter(Boolean).length / 2.6 + 0.4);

/** duration without ffprobe: WAV from its header, CBR MP3 from the bitrate in the filename's format */
export function audioSeconds(file, kbps = 128) {
  const st = fs.statSync(file);
  if (file.endsWith('.wav')) {
    const h = Buffer.alloc(44); const fd = fs.openSync(file, 'r'); fs.readSync(fd, h, 0, 44, 0); fs.closeSync(fd);
    return +((st.size - 44) / h.readUInt32LE(28)).toFixed(2);
  }
  return +((st.size * 8) / (kbps * 1000)).toFixed(2); // CBR mp3_<rate>_<kbps>
}

function silentWav(sec, sr = 8000) {
  const n = Math.round(sec * sr), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b;
}
