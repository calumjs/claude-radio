# Claude Radio 📻

A radio station that **Claude Code runs**. Pick a station on the dial, or type the one you want ("two grumpy chefs on
the history of food"). Claude researches real material on the web, writes segments for a cast of hosts, and voices
them with ElevenLabs. It keeps going for as long as you listen. Music stations play through
[Claude DJ](https://github.com/calumjs/claude-dj) (a submodule), with the music ducked under the hosts.

```
you (typing in Claude Code, or the tuner) ──► Claude + radio skills ──► node radio.mjs … ──► server ──► tuner tab ──► speakers
                                   │  WebSearch / WebFetch (research)        │  ElevenLabs TTS + SFX
                                   └──► node radio.mjs dj … ──► Claude DJ ◄──┘  (embedded in the tuner, ducked under voices)
```

## Quick start
Requirements: **Node 20+**, an **ElevenLabs API key** in `ELEVENLABS_API_KEY`, a Chromium browser, and
[Claude Code](https://claude.com/claude-code). For music stations: ffmpeg (Claude DJ's requirement).

```bash
git clone --recurse-submodules <this repo> claude-radio && cd claude-radio
node radio.mjs start          # starts the server and opens http://localhost:4848
```
Click **Power on** in the tab, then open Claude Code in this folder and talk to it:

- `put on the science station` · `tune to 94.5`
- `make me a station about the weirdest laws in the world, two hosts, one very sceptical`
- `more about that` · `shorter segments` · `make them argue more`
- `put on Hardstyle 150` · `less chat, more music` · `play Sandstorm`

Typing a station into the tuner's box or a question into the booth works too: it lands in Claude's inbox.

To reuse an existing Claude DJ install (with its crate) instead of the submodule, create `config.local.json`:
```json
{ "dj": { "dir": "C:/path/to/claude-dj" } }
```

## How it works
| Piece | What it does |
|---|---|
| `server.mjs` | Stations, the on-air queue, ElevenLabs rendering (cached), long-poll `wait` so Claude knows when to write more, listener inbox, booth log, Claude DJ bridge + ducking. |
| `radio.mjs` | The CLI Claude drives (`node radio.mjs help`); `radio dj …` passes through to Claude DJ. |
| `public/` | The tuner: FM dial, presets, "type your own station", hosts with a speaking glow, live captions, transcript, sources, up next, booth, and the embedded Claude DJ. |
| `lib/eleven.mjs` | Voices, text-to-speech (`eleven_v3` with audio tags, falling back to `eleven_multilingual_v2`), sound-effect idents. |
| `lib/stations.mjs` | Preset (`stations/*.json`) and custom stations, a notebook per station and an aired log, so nothing repeats across sessions. |
| `lib/script.mjs` | The segment script format: `NAME: line`, `# title`, `# source`, `# duck`, `SFX:`. |

### Skills (`.claude/skills/`)
| Skill | Use |
|---|---|
| `radio` | Front door: boot, tune, direction → commands, full CLI reference. |
| `radio-on-air` | The broadcast loop: buffer pacing, the station clock, steering, background research agents, the quality bar. |
| `radio-station` | Turn a prompt into a station: format, brief, a cast of ElevenLabs voices with personas, a show clock. |
| `radio-research` | Real research with WebSearch/WebFetch, verifying facts, sources on air, the station notebook. |
| `radio-script` | Writing for the ear: banter, hooks, numbers, v3 audio tags, segment shapes. |
| `radio-music` | Music and mixed stations through Claude DJ: talk breaks over intros/outros, ducking, steering. |
| `radio-troubleshoot` | Symptom → fix table. |

## Stations on the dial
88.7 **The Assembly Line** (AI and software factories, a panel) · 91.7 **The Wire** (today's news) · 94.5 **Long Ago FM** (history as story) ·
97.9 **Hardstyle 150** (music, via Claude DJ) · 101.3 **Odd Hours** (strange but true) · 104.1 **Lines Open** (late-night call-in + prank calls) ·
107.3 **Buy Now 107** (parody home shopping, plus real consumer research)

Or type your own in the tuner: Claude designs the station, casts the voices and goes on air.

## Tests
`node --test test/*.test.mjs`: server tests run on a scratch port and data dir with `RADIO_TTS=fake` (silent audio, no credits).
