import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DJBridge, djEnvironment } from '../lib/dj-bridge.mjs';

test('DJ processes use the configured local port and reject unsupported CLI endpoints', () => {
  assert.equal(djEnvironment('http://127.0.0.1:4999', {}).DJ_PORT, '4999');
  assert.equal(djEnvironment('http://localhost', {}).DJ_PORT, '80');
  for (const url of ['https://localhost:4747', 'http://example.com:4747', 'http://localhost:4747/dj', 'http://user:pass@localhost:4747']) {
    assert.throws(() => djEnvironment(url, {}), /local HTTP DJ URL/);
  }
});

test('ducking is serialized, failures retain the restore volume, interrupted release does not ratchet', async (t) => {
  let volume = 0.8, fail = false;
  const commands = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/state') return res.end(JSON.stringify({ engine: { connected: true }, master: { volume }, decks: {} }));
    let text = ''; for await (const chunk of req) text += chunk;
    const cmd = JSON.parse(text); commands.push(cmd);
    if (fail) return res.end(JSON.stringify({ ok: false, error: 'engine moved' }));
    // Simulate a release ramp which has only reached 0.4 when polled again.
    volume = cmd.args.value === 0.8 ? 0.4 : cmd.args.value;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const bridge = new DJBridge({ dir: '.', url: `http://127.0.0.1:${server.address().port}` });
  await bridge.poll();
  await Promise.all([bridge.duck(true), bridge.duck(true)]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].args.value, 0.24);
  fail = true;
  await assert.rejects(bridge.duck(false), /engine moved/);
  assert.equal(bridge.ducked, 0.8);
  fail = false;
  await bridge.duck(false);
  await bridge.duck(true);
  assert.equal(bridge.ducked, 0.8);
  assert.equal(commands.at(-1).args.value, 0.24);
  await bridge.duck(false);
  assert.equal(commands.at(-1).args.value, 0.8);
});
