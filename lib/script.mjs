// Segment scripts. Claude writes plain text (easier to write for the ear than JSON):
//
//   # title: The waterfall under the ocean
//   # source: NOAA Ocean Explorer | https://oceanexplorer.noaa.gov/...
//   # duck: off            (optional: don't dip the music under this one)
//   # kind: talk           (talk | news | ident | break)
//   MAYA: [curious] Okay, so there's a waterfall... under the sea.
//   OWEN: You're making that up.
//
// A line without a speaker continues the previous line. JSON ({ title, lines: [{ host, text }] }) works too.

export function parseScript(src) {
  const t = String(src).trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t);
    return { title: j.title || 'Untitled', kind: j.kind || 'talk', duck: j.duck !== false, sources: j.sources || [], lines: (j.lines || []).map((l) => ({ host: l.host, text: String(l.text).trim() })) };
  }
  const seg = { title: '', kind: 'talk', duck: true, sources: [], lines: [] };
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const meta = /^#\s*(\w+)\s*:\s*(.*)$/.exec(line);
    if (meta) {
      const [, k, v] = meta;
      if (k === 'title') seg.title = v;
      else if (k === 'kind') seg.kind = v;
      else if (k === 'duck') seg.duck = !/^(off|no|false)$/i.test(v);
      else if (k === 'source' || k === 'sources') {
        for (const part of v.split(/\s*;\s*/)) {
          const [a, b] = part.split(/\s*\|\s*/);
          seg.sources.push(b ? { title: a, url: b } : { title: a.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], url: a });
        }
      }
      continue;
    }
    if (line.startsWith('#')) continue;
    const m = /^([A-Za-z][\w .'-]{0,30}?)\s*:\s+(.+)$/.exec(line);
    if (m && !/^https?$/i.test(m[1])) seg.lines.push({ host: m[1].trim(), text: m[2].trim() });
    else if (seg.lines.length) seg.lines[seg.lines.length - 1].text += ' ' + line;
    else throw new Error(`line has no speaker: "${line.slice(0, 60)}" (write "NAME: text")`);
  }
  if (!seg.lines.length) throw new Error('script has no lines');
  seg.title ||= seg.lines[0].text.replace(/\[[^\]]*\]/g, '').slice(0, 50);
  return seg;
}
