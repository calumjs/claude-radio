import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FakeEngine } from '../dj/test/server-harness.mjs';
import { combined, api, until, player } from './helpers/combined.mjs';

class RadioEngine extends FakeEngine {
  async onCmd(message) {
    if (message.cmd === 'master') this.master.volume = message.args.value;
    return super.onCmd(message);
  }
}

test('Radio and real DJ server share CLI, ducking, station lifecycle and player ownership', async (t) => {
  const app = await combined(); t.after(app.stop);
  const engine = new RadioEngine(app.djBase); await engine.start(); t.after(() => engine.stop());
  let listener = await player(app.base); t.after(() => listener.close());
  const post = (p, b) => api(app.base, p, b);
  const state = () => api(app.base, '/api/state');
  await post('/api/tune', { station: 'hardstyle-150' });
  await until(async () => (await state()).dj.engine);

  const cli = await promisify(execFile)(process.execPath, ['radio.mjs', 'dj', 'master', '0.7'], { cwd: app.dir });
  assert.match(cli.stdout, /0.7/);
  assert.equal(engine.master.volume, 0.7, 'CLI reached the custom DJ port');
  await engine.set('A', { playing: true, title: 'Synthetic test track', bpm: 150, duration: 120, audible: 1 });
  await post('/api/player/talking', { client: listener.id, on: true });
  assert.equal(engine.master.volume, 0.21);
  await post('/api/player/talking', { client: listener.id, on: false });
  assert.equal(engine.master.volume, 0.7);

  await post('/api/segment', { script: 'JAX: Music station lifecycle test.', wait: true });
  const { segment } = await post('/api/player/next', { client: listener.id });
  assert.equal((await state()).onAir.id, segment.id);
  await post('/api/player/talking', { client: listener.id, on: true });
  await post('/api/tune', { station: 'the-wire' });
  await until(() => !engine.decks.A.playing && engine.master.volume === 0.7);
  assert.equal((await state()).onAir, null);

  await post('/api/tune', { station: 'hardstyle-150' });
  await post('/api/segment', { script: 'JAX: Skip this music break.', wait: true });
  await post('/api/player/next', { client: listener.id });
  await post('/api/player/talking', { client: listener.id, on: true });
  await post('/api/skip', {});
  await until(() => engine.master.volume === 0.7);

  await post('/api/segment', { script: 'JAX: Restore even without the delayed browser report.', wait: true });
  const next = await post('/api/player/next', { client: listener.id });
  await post('/api/player/talking', { client: listener.id, on: true });
  await post('/api/player/done', { id: next.segment.id });
  await until(() => engine.master.volume === 0.7);

  await post('/api/player/talking', { client: listener.id, on: true });
  const old = listener; listener = await player(app.base);
  await until(() => engine.master.volume === 0.7);
  const stale = await post('/api/player/talking', { client: old.id, on: true });
  assert.equal(stale.ok, false);
  old.close();

  await post('/api/player/talking', { client: listener.id, on: true });
  listener.close();
  await until(() => engine.master.volume === 0.7);
  listener = await player(app.base);

  await engine.set('A', { playing: true });
  await post('/api/player/talking', { client: listener.id, on: true });
  await post('/api/tune', { prompt: 'A new talk station', source: 'ui' });
  await until(() => !engine.decks.A.playing && engine.master.volume === 0.7);
  assert.equal((await state()).pending.prompt, 'A new talk station');
});
