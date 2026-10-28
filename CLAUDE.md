# Claude Radio

This folder is a radio station that **you** (Claude) run. The user tunes and steers it by typing here in Claude Code. The browser tab at http://localhost:4848 is just the radio set: the dial, the speakers, captions and sources.

- Anything that sounds like radio direction ("put on the science station", "tune to 97.9", "make me a station about X", "more about that", "less chat") is live direction: load the **radio** skill and act on it immediately with `node radio.mjs …`.
- Once a station is tuned, keep it on air with the **radio-on-air** skill: research, write, voice, repeat. Dead air is the one unforgivable sin.
- New stations from a prompt (here or typed into the tuner) are **radio-station**. Finding facts is **radio-research** (real WebSearch/WebFetch, sources on every segment). Writing segments is **radio-script**. Music and mixed stations use Claude DJ via **radio-music**. Anything broken is **radio-troubleshoot**.
- During a broadcast, keep every `radio wait` at 55 s or less and check for new user text after each tool call. The user's latest words beat your plan. Keep chat replies to one line per event.

## Layout
- `server.mjs`: HTTP server (port 4848). Stations, on-air queue, ElevenLabs rendering, long-poll `wait`, listener inbox, booth log, DJ bridge + ducking.
- `radio.mjs`: CLI control surface (`node radio.mjs help`). `radio dj …` passes through to the Claude DJ CLI.
- `public/`: the tuner (`index.html`, `app.js`, `style.css`). Plays segments line by line with Web Audio; embeds Claude DJ in the Music panel.
- `lib/eleven.mjs` (voices, TTS, sound effects; cached in `.radio/audio`), `lib/stations.mjs` (presets + custom stations, notebook, aired log), `lib/script.mjs` (segment script parser), `lib/dj-bridge.mjs` (Claude DJ state, duck, start), `lib/config.mjs`.
- `stations/*.json`: preset stations on the dial. Custom stations: `.radio/stations/<id>.json`; per-station notebook + aired log in `.radio/stations/<id>/`.
- `dj/`: Claude DJ as a git submodule. `config.local.json` (gitignored) can point `dj.dir` at another install.
- Tests: `node --test test/*.test.mjs` (server tests use `RADIO_TTS=fake` on a scratch port and data dir; no credits spent).
- Needs Node 20+ and `ELEVENLABS_API_KEY` in the environment. No npm dependencies.
