// config.json (checked in) deep-merged with config.local.json (gitignored: your own DJ path, voices, model).
import fs from 'node:fs';
import path from 'node:path';

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};
const read = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };

export function loadConfig(root) {
  return merge(read(path.join(root, 'config.json')), read(path.join(root, 'config.local.json')));
}
