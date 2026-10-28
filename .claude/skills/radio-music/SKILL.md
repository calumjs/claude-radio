---
name: radio-music
description: Music and mixed stations on Claude Radio — boot Claude DJ (the `dj` submodule) inside the tuner, pick and mix tracks for the station's genre, and time host talk breaks over intros/outros with the music ducked underneath. Use when the tuned station's format is music or mixed, the user asks for songs/a genre on the radio, "play X", "less chat more music", or invokes /radio-music.
---

# Music on the radio: Claude DJ under the hosts

Claude DJ does the music. It is the `dj/` git submodule (or whatever `dj.dir` points to in `config.local.json`, e.g. an existing install with a full crate). The tuner embeds the DJ page in its Music panel; the radio server ducks the DJ master automatically while a host talks (`# duck: off` on a segment to stop that).

## 1. Boot
1. `radio status`, which shows a `MUSIC` line for music/mixed stations. Tuning a music station starts the DJ server automatically; otherwise `radio dj-start`.
2. `DJ engine not started` → tell the user once: *"Click **Start engine** in the radio's Music panel."* (The panel opens itself and shows a yellow hint.)
3. Read the DJ craft once per session, using the DJ dir printed by `radio status --json` (`djDir`): `<djDir>/.claude/skills/dj/SKILL.md` (CLI), `dj-set` (the set loop), `dj-mix` (transitions), `dj-crate` (finding/downloading music). Every DJ command runs through the radio CLI: `node radio.mjs dj <args>`, e.g. `node radio.mjs dj library --bpm 148-155`, `node radio.mjs dj load A "Sandstorm"`.

## 2. The music-station loop
Follow `dj-set` for the music (energy arc, harmonic picks, phrase-timed mixes; auto-DJ is the safety net if you're busy researching), and slot talk in like a real station:
```
  1. radio dj status → live deck, remaining, mix-out
  2. load the next track on the idle deck (dj-set rules + the station's music brief)
  3. talk break? (every 2–3 tracks on music stations, every track on mixed)
       write it while the current track plays, then time it:
       radio wait music --seconds <talk length + ~10> --timeout 55   (loop on timeout)
       queue the break → it airs ducked over the outro and into the new intro
  4. radio dj mix <live> <idle> --at phrase --why "…"   (dj-mix for style)
  5. radio dj wait transition --timeout 55
```
- **Never talk over a drop or a vocal hook.** Talk over intros, outros and breakdowns: `radio dj track <id>` gives intro/outro/breakdown bars. A 15 s break fits a typical 16–32 bar intro.
- **Back-announce + forward-announce**: "That was Headhunterz with Dragonborn… coming up, the track that closed Defqon in 2012." One researched fact about an artist or track beats generic hype; research it like any other segment (radio-research) and add `# source:` lines.
- **Mixed stations**: longer talk (1–2 min) goes between tracks: let the outgoing track fade (`radio dj mix … --style fade`) or loop its outro (`radio dj loop <deck> 16`), queue the talk, then bring the next track in when `radio wait empty` returns.
- Keep track picks on-brief; if the crate is thin for the genre, `radio dj get "artist - title"` (dj-crate: extended/original mixes) while the current track plays.

## 3. Steering
| User says | Do |
|---|---|
| "play X" | `radio dj library X` (or `radio dj get "X"`), load on the idle deck, mix at the next phrase; a host intro if there's room |
| "less chat" / "just music" | stop queuing breaks except idents; say it once on air |
| "more chat" | talk break every track; consider switching to mixed |
| "harder" / "chill" | dj-set energy direction (`radio dj suggest --direction up|down`) |
| "louder music" / "quieter" | `radio dj master 0.9` / `0.6` |
| "don't duck" / "voices are too loud" | `# duck: off` on breaks, or a gentler duck (`dj.duckLevel` 0.5 in config.local.json, restart the server) |

The user's standing DJ preferences (memory) still apply on radio: blend live rather than echoing out to silence, let songs speak, hardstyle drops play unmixed.
