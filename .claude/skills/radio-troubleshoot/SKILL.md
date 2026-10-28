---
name: radio-troubleshoot
description: Diagnose and recover Claude Radio — server down, no sound, segments stuck "voicing", ElevenLabs errors (quota, bad voice, model), dead air, the tuner not updating, Claude DJ missing or silent inside the tuner, ducking stuck. Use when something sounds wrong, a radio command errors, or `radio status` shows warnings.
---

# Troubleshooting Claude Radio

Start with `node radio.mjs status` and `node radio.mjs log --n 40` (server log: `.radio/server.log`).

| Symptom | Check / fix |
|---|---|
| `Radio server is not running` | `node radio.mjs start`. If it dies at once, read `.radio/server.log` (port 4848 in use → set `port` in `config.local.json`). |
| `No listener` / silence | The tab needs **Power on** clicked (browser autoplay rule). Reloading the tab needs another click. |
| `VOICES fake` | `ELEVENLABS_API_KEY` isn't set in the environment that started the server. Set it, then restart the server (kill its PID; `node radio.mjs start`). `RADIO_TTS=fake` forces fake mode on purpose. |
| Segment stuck `synth`/`voicing` | Rendering in progress (a few s per line). Over ~30 s: check the log for HTTP errors. The player skips a stuck head after 20 s. |
| `TTS HTTP 401` | Bad key or missing `text_to_speech` permission on the key. |
| `TTS HTTP 429` / quota | Out of credits or rate-limited: shorter segments, fewer re-renders (identical lines are cached in `.radio/audio`), or switch `elevenlabs.model` to `eleven_flash_v2_5` in `config.local.json`. |
| `no ElevenLabs voice called "X"` | `radio voices --refresh`, then fix the host's `voice` (`radio station update`). |
| Tags read aloud ("bracket laughs") | Only happens if a non-v3 model is used without stripping; the server strips tags for non-v3 models, so check `elevenlabs.model`. |
| Dead air warnings | You stopped feeding the queue. Queue something short now, then follow the radio-on-air loop (`wait low --seconds 150`). |
| `the listener is on X now; segment … dropped` | They changed station while you wrote. Expected: drop it and go to the new station. |
| Music panel says DJ offline | `radio dj-start`; if it says not installed, `git submodule update --init` or point `dj.dir` at an existing Claude DJ in `config.local.json`. |
| DJ engine off | The user clicks **Start engine** inside the Music panel (iframe). |
| Music stuck quiet (ducked) | `radio dj master 0.9`. Happens if the tab closed mid-segment. |
| Two Claude DJ tabs fighting | Only one page can be the DJ engine; close the standalone http://localhost:4747 tab or click Start engine in the one you want. |
| Disk filling | `.radio/audio` is a cache of rendered lines; safe to delete while the server is stopped. |
