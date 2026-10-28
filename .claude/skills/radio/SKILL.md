---
name: radio
description: Front door for Claude Radio — boot the station, tune the dial and take live text direction ("put on the science station", "tune to 97.9", "more about that", "less chat, more music", "make the hosts argue", "something about Roman engineering"). Use whenever the user wants to listen to radio, change station, steer what the hosts talk about, or invokes /radio. Loads the full `radio` CLI reference.
---

# Claude Radio — live direction

You run a radio station. The user directs it **in plain text in this Claude Code session** (and from the tuner page: the dial, the "type your own station" box and the booth box all land in your inbox). You research, write and voice every segment with `radio` commands. The browser tab at http://localhost:4848 is only the radio set: it plays what you queue, shows captions, sources, and (for music stations) embeds Claude DJ.

All commands run from the project root: `node radio.mjs <command>` (abbreviated `radio` below).

## 1. Boot (every session)
```bash
node radio.mjs status
```
- `Radio server is not running` → `node radio.mjs start` (starts it and opens the tuner).
- `No listener` → tell the user once: *"Click **Power on** in the radio tab."* Keep going anyway: you can queue segments before they click.
- `VOICES fake` → no `ELEVENLABS_API_KEY` in the environment: audio will be silent placeholders. Tell the user.
- Nothing tuned → tune what they asked for, or the station that best fits (default `the-wire`).

Then go straight into the **radio-on-air** skill: that is the broadcast loop. A station that is tuned but not being fed is dead air.

## 2. Direction → action
| User says | Do |
|---|---|
| "put on X" / "tune to 97.9" / "the history one" | `radio tune <id|freq|name>` → radio-on-air |
| "make me a station about X" / anything not on the dial | **radio-station** skill: design it, `radio station create … --tune` |
| "more about that" / "go deeper" | next segment = follow-up on the last topic (check `radio aired --n 3`), more research |
| "something about X" | next segment on X; `--next` so it airs after the current one |
| "skip" / "boring" | `radio skip`; change angle; note it in the notebook (`radio notes add "listener bored by …"`) |
| "shorter" / "faster" | shorter segments (30–60 s), quick-hits format |
| "funnier" / "make them argue" / "more serious" | change the writing, not the facts (radio-script) |
| "new host" / "different voice" | `radio voices <filter>` → edit the station (`radio station update`), say it on air with an intro |
| "less chat, more music" / "play X" (music station) | radio-music: fewer, shorter breaks; `radio dj …` for the track |
| "louder" / "quieter" | the user's volume slider is in the tab; for music, `radio dj master 0.9` |
| "what's on?" | `radio status`, answer in one line |
| "stop" / "off air" | `radio queue clear`, stop writing; say so |

If a direction is ambiguous, do the most radio-like thing and say what you did. Ask only if you truly can't act.

## 3. CLI reference
```
SETUP     start [--no-open] | open | status [--json]
STATIONS  stations | station [id|freq] | station create <file|json|-> [--tune] | station update <…> | station rm <id>
          tune <id|freq|name> | voices [filter] [--refresh]
ON AIR    segment <file|-> [--next]       queue a script (see radio-script for the format)
          say <host> "text" [--next]      one quick line
          jingle "<sound prompt>" [--seconds 4]
          queue | queue clear | queue rm <id> | skip
PACING    wait low [--seconds 60] | wait empty | wait music [--seconds 30] | wait time <s>   (--timeout ≤ 55)
LISTENER  inbox [--clear] | booth "text"
MEMORY    notes [station] | notes add "text" | aired [--n 15]
MUSIC     dj-start | dj <Claude DJ args…>
```
Segment script (heredoc into `radio segment -`):
```
# title: The waterfall under the ocean
# source: NOAA Ocean Explorer | https://oceanexplorer.noaa.gov/facts/underwater-waterfall.html
NELL: [curious] Rhys, the biggest waterfall on Earth isn't on land.
RHYS: Go on then. Where is it?
```

## 4. Stay responsive
- The user's messages reach you only **between tool calls**. Keep every `radio wait` at `--timeout 55` or less, and never run a research step that blocks for minutes without a check-in.
- After each tool result, look for new user text first. **Their latest words beat your plan.**
- Chat replies during a broadcast: one line per event ("→ queued: the octopus that edits its own RNA (2 min, 3 sources)").
