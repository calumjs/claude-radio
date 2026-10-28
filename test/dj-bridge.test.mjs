import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DJBridge, STATION_PAUSE, djEnvironment } from '../lib/dj-bridge.mjs';

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

function fakeDJ(t, handle) {
  const server = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    let text = ''; for await (const chunk of req) text += chunk;
    res.end(JSON.stringify(handle(req.url, text && JSON.parse(text))));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

test('a talk suspension that fails partway is retried, then held', async (t) => {
  let volume = 0.8, playing = true, failMute = true;
  const commands = [];
  const url = await fakeDJ(t, (p, cmd) => {
    if (p === '/api/state') return { engine: { connected: true }, master: { volume }, decks: { A: { playing, trackId: 'a', position: 1 } } };
    if (p.startsWith('/api/log')) return [];
    commands.push(cmd.cmd);
    if (cmd.cmd === 'master' && failMute) return { ok: false, error: 'engine dropped' };
    if (cmd.cmd === 'master') volume = cmd.args.value;
    if (cmd.cmd === 'pause') playing = false;
    return { ok: true };
  });
  const bridge = new DJBridge({ dir: '.', url });
  await assert.rejects(bridge.setMusicEnabled(false), /engine dropped/);
  assert.equal(bridge.suspended.complete, false);
  failMute = false;
  await bridge.setMusicEnabled(false); // the server's 2 s check retries an incomplete suspension
  assert.equal(volume, 0);
  assert.equal(playing, false);
  assert.equal(bridge.suspended.complete, true);
  assert.equal(bridge.suspended.volume, 0.8, 'retry keeps the original restore volume');
  const sent = commands.length;
  await bridge.setMusicEnabled(false);
  assert.equal(commands.length, sent, 'a completed suspension is not repeated');
});

test('after a Radio restart, music gives back only a master that Radio muted', async (t) => {
  let log = [{ kind: 'claude', text: STATION_PAUSE }, { kind: 'action', text: 'master value=0' }];
  const commands = [];
  const url = await fakeDJ(t, (p, cmd) => {
    if (p === '/api/state') return { engine: { connected: true }, master: { volume: 0 }, decks: {} };
    if (p.startsWith('/api/log')) return log;
    commands.push(cmd);
    return { ok: true };
  });
  await new DJBridge({ dir: '.', url }).setMusicEnabled(true);
  assert.deepEqual(commands.map((c) => [c.cmd, c.args.value]), [['master', 0.9]]);
  commands.length = 0;
  log = [...log, { kind: 'action', text: 'master value=0' }]; // someone else zeroed it since
  await new DJBridge({ dir: '.', url }).setMusicEnabled(true);
  assert.deepEqual(commands, []);
});
