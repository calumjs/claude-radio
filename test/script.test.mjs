import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScript } from '../lib/script.mjs';

test('parses meta, speakers, continuations and sources', () => {
  const s = parseScript(`# title: Under the sea
# source: NOAA | https://noaa.gov/x
# source: https://www.si.edu/ocean; Smithsonian | https://si.edu/y
# duck: off
NELL: [curious] The biggest waterfall
is underwater.
RHYS: No way.`);
  assert.equal(s.title, 'Under the sea');
  assert.equal(s.duck, false);
  assert.deepEqual(s.lines, [{ host: 'NELL', text: '[curious] The biggest waterfall is underwater.' }, { host: 'RHYS', text: 'No way.' }]);
  assert.deepEqual(s.sources.map((x) => x.title), ['NOAA', 'si.edu', 'Smithsonian']);
});

test('SFX lines and JSON scripts', () => {
  assert.equal(parseScript('SFX: sonar ping (2s)\nNELL: hi').lines[0].host, 'SFX');
  const j = parseScript(JSON.stringify({ title: 'J', lines: [{ host: 'A', text: ' hi ' }] }));
  assert.equal(j.lines[0].text, 'hi');
  assert.equal(j.duck, true);
});

test('rejects a script without speakers', () => {
  assert.throws(() => parseScript('just some text'), /no speaker/);
  assert.throws(() => parseScript('# title: x'), /no lines/);
});
