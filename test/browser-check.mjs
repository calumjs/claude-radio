// Optional real Chromium check. Use an already installed Playwright; no downloads,
// TTS credits, existing music library or live DJ instance are used.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { combined, api, until } from './helpers/combined.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const app = await combined({ station: 'the-wire' });
let browser;
const checks = [], errors = [];
const evidence = process.env.RADIO_EVIDENCE_DIR;
try {
  // A harmless 60-second tone with a 150 BPM pulse, written only to the scratch crate.
  const sr = 44100, frames = sr * 60, wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const time = i / sr, pulse = Math.exp(-30 * (time % 0.4));
    wav.writeInt16LE(Math.round(3500 * (0.3 + pulse) * Math.sin(2 * Math.PI * 220 * time)), 44 + i * 2);
  }
  fs.writeFileSync(path.join(app.djDir, 'library', 'Integration tone.wav'), wav);
  await api(app.djBase, '/api/library/scan', {});
  const track = await until(async () => (await api(app.djBase, '/api/library')).tracks[0], 30000);
  checks.push('Synthetic track scanned and analysed by the real DJ server');

  browser = await chromium.launch({ headless: true, args: ['--mute-audio'], ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.addInitScript(() => {
    globalThis.__audioMeters = [];
    const create = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function (...args) {
      const meter = create.apply(this, args); globalThis.__audioMeters.push(meter); return meter;
    };
    globalThis.__eventStreams = [];
    const Events = EventSource;
    globalThis.EventSource = class extends Events {
      constructor(...args) { super(...args); globalThis.__eventStreams.push(this); }
    };
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.base);
  assert.equal(await page.locator('#music').isHidden(), true);
  assert.equal(await page.locator('#djToggle').isDisabled(), true);
  assert.equal(await page.locator('#djIframe').getAttribute('src'), null);
  checks.push('Initial saved talk station hides and disables DJ without loading an audio iframe');
  await page.locator('#powerBtn').click();
  await page.locator('[data-id="hardstyle-150"]').click();
  const frame = page.frameLocator('#djIframe');
  await frame.locator('#startBtn').click();
  await until(async () => (await api(app.djBase, '/api/state')).engine.connected);
  checks.push('Radio tuner powers on; embedded DJ starts its real AudioContext and AudioWorklet');
  const command = async (cmd, args) => {
    const result = await api(app.djBase, '/api/cmd', { cmd, args });
    assert.equal(result.ok, true, result.error);
  };
  await command('load', { deck: 'A', track: track.id });
  await command('play', { deck: 'A' });
  await until(async () => (await api(app.djBase, '/api/state')).decks.A.position > 0.3);
  const djPage = page.frames().find((f) => f.url().startsWith(app.djBase));
  await until(() => djPage.evaluate(() => globalThis.__audioMeters.some((meter) => {
    const samples = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length) > 0.001;
  })));
  await until(async () => (await page.locator('#nowPlaying').innerText()).includes('Integration tone'));
  checks.push('Real PCM loads, output analyser measures non-silent audio, deck advances and Radio shows the track');
  const observer = await browser.newPage();
  await observer.goto(app.base);
  await observer.locator('#music').waitFor({ state: 'visible' });
  assert.equal(await observer.locator('#djToggle').isEnabled(), true);
  await observer.close();
  checks.push('Initial music-station page shows/enables the DJ set without claiming or starting playback');

  // Fake TTS is a silent WAV: verifies the voice player and duck protocol without narration generation.
  const queued = await api(app.base, '/api/segment', { script: '# title: Integration check\nJAX: Testing the combined music and radio player now.', wait: true });
  assert.equal(queued.ok, true);
  await until(async () => (await api(app.base, '/api/state')).dj.ducked);
  await until(async () => (await api(app.djBase, '/api/state')).master.volume < 0.35);
  checks.push('Silent test segment plays through Radio and ducks the real DJ master');
  if (evidence) {
    fs.mkdirSync(evidence, { recursive: true });
    if ((await page.locator('#djFrame').getAttribute('class')).includes('collapsed')) await page.locator('#djToggle').click();
    await page.screenshot({ path: path.join(evidence, 'combined-radio.png'), fullPage: true });
  }
  await until(async () => {
    const state = await api(app.base, '/api/state');
    return !state.onAir && !state.dj.ducked && (await api(app.djBase, '/api/state')).master.volume >= 0.89;
  }, 15000);
  checks.push('Speech completion restores music to its original 0.9 master volume');
  const iframeSource = await page.locator('#djIframe').getAttribute('src');
  await page.locator('[data-id="the-wire"]').click();
  await until(async () => { const state = await api(app.djBase, '/api/state'); return !state.decks.A.playing && state.master.volume === 0; });
  assert.equal(await page.locator('#music').isHidden(), true);
  assert.equal(await page.locator('#djToggle').isDisabled(), true);
  assert.equal(await page.locator('#music').evaluate((el) => el.inert), true);
  const pausedPosition = (await api(app.djBase, '/api/state')).decks.A.position;
  if (evidence) await page.screenshot({ path: path.join(evidence, 'talk-disabled.png'), fullPage: true });
  checks.push('Music to talk hides/disables the same DJ iframe, mutes the master and pauses the deck');
  await page.locator('[data-id="hardstyle-150"]').click();
  await until(async () => { const state = await api(app.djBase, '/api/state'); return state.decks.A.playing && state.master.volume >= 0.89; });
  const resumed = (await api(app.djBase, '/api/state')).decks.A;
  assert.equal(resumed.trackId, track.id);
  assert.ok(resumed.position >= pausedPosition && resumed.position < pausedPosition + 3);
  assert.equal(await page.locator('#djIframe').getAttribute('src'), iframeSource);
  assert.equal(await page.locator('#music').isVisible(), true);
  assert.equal(await page.locator('#music').evaluate((el) => el.inert), false);
  if (evidence) await page.screenshot({ path: path.join(evidence, 'music-resumed.png'), fullPage: true });
  checks.push('Talk to music restores the previous track/position and master without reloading the iframe');
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-id="the-wire"]').click();
    await until(async () => { const state = await api(app.djBase, '/api/state'); return !state.decks.A.playing && state.master.volume === 0; });
    await page.locator('[data-id="hardstyle-150"]').click();
    await until(async () => { const state = await api(app.djBase, '/api/state'); return state.decks.A.playing && state.master.volume >= 0.89; });
  }
  checks.push('Repeated station switches preserve the set and original master volume');
  await command('pause', { deck: 'A' });
  await page.locator('[data-id="the-wire"]').click();
  await until(async () => (await api(app.djBase, '/api/state')).master.volume === 0);
  await page.locator('[data-id="hardstyle-150"]').click();
  await until(async () => (await api(app.djBase, '/api/state')).master.volume >= 0.89);
  assert.equal((await api(app.djBase, '/api/state')).decks.A.playing, false);
  checks.push('An explicitly paused deck stays paused after talk to music');
  await command('play', { deck: 'A' });
  await page.locator('[data-id="the-wire"]').click();
  await until(async () => (await api(app.djBase, '/api/state')).master.volume === 0);
  await command('pause', { deck: 'A' });
  await page.locator('[data-id="hardstyle-150"]').click();
  await until(async () => (await api(app.djBase, '/api/state')).master.volume >= 0.89);
  assert.equal((await api(app.djBase, '/api/state')).decks.A.playing, false);
  checks.push('An explicit stop during talk cancels automatic music resume');
  await command('play', { deck: 'A' });
  await api(app.base, '/api/segment', { script: 'JAX: This silent test break should be skipped before it finishes playing.', wait: true });
  await until(async () => (await api(app.base, '/api/state')).dj.ducked);
  await page.locator('#skipBtn').click();
  await until(async () => !(await api(app.base, '/api/state')).dj.ducked && (await api(app.djBase, '/api/state')).master.volume >= 0.89);
  assert.equal((await api(app.djBase, '/api/state')).decks.A.playing, true);
  checks.push('Skipping a music-station host break releases the duck and leaves the set enabled/playing');
  await page.locator('#askInput').fill('Browser integration request');
  await page.locator('#askForm button').click();
  await until(async () => (await api(app.base, '/api/inbox')).some((m) => m.text === 'Browser integration request'));
  checks.push('Browser booth request reaches the Radio inbox');
  await api(app.base, '/api/segment', { script: 'JAX: Disconnecting the radio player should release this silent test duck.', wait: true });
  await until(async () => (await api(app.base, '/api/state')).dj.ducked);
  await page.evaluate(() => globalThis.__eventStreams.filter((stream) => stream.url.includes('player=1')).forEach((stream) => stream.close()));
  await until(async () => !(await api(app.base, '/api/state')).dj.ducked && (await api(app.djBase, '/api/state')).master.volume >= 0.89);
  checks.push('Disconnecting the active Radio stream restores the real DJ master');
  assert.deepEqual(errors, []);
  checks.push('No uncaught browser errors');
  if (evidence) fs.writeFileSync(path.join(evidence, 'browser-result.json'), JSON.stringify({ passed: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, errors }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks, errors, failure: error.message,
    radioState: await api(app.base, '/api/state').catch(() => null),
    djState: await api(app.djBase, '/api/state').catch(() => null),
    djLog: await api(app.djBase, '/api/log?n=30').catch(() => null), logs: app.logs }, null, 2));
  process.exitCode = 1;
} finally { await browser?.close(); await app.stop(); }
