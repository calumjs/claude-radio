---
name: radio-script
description: Writing Claude Radio segments for the ear — multi-host banter that sounds like real radio, the script format (NAME: line, # title / # source / # duck / # kind, SFX lines), ElevenLabs v3 audio tags and delivery tricks, segment shapes (open, deep dive, quick hits, story, myth-or-fact, talk break). Use whenever you write a segment for `radio segment`.
---

# Writing for the ear

## 1. Format
```
# title: The waterfall under the ocean          (shown in the tuner; keep it short)
# source: NOAA Ocean Explorer | https://oceanexplorer.noaa.gov/facts/underwater-waterfall.html
# source: Smithsonian Ocean | https://ocean.si.edu/…
# kind: talk                                     (talk | news | ident | break)
# duck: off                                      (optional: music stations — don't dip the music)
SFX: soft sonar ping (2s)                        (optional ElevenLabs sound effect, seconds in brackets)
NELL: [curious] Rhys. The biggest waterfall on Earth... isn't on land.
RHYS: [laughs] You say that like I'm supposed to know where it is.
NELL: Under the sea, between Greenland and Iceland. It's called the Denmark Strait cataract.
```
Queue with a heredoc: `node radio.mjs segment - <<'EOF' … EOF` (add `--next` to jump the queue). Speaker names are the station's host names (case-insensitive). A line without `NAME:` continues the previous line.

## 2. Sound like radio, not an essay
- **Short lines, real turns.** 1–3 sentences per line. Hosts interrupt, react, finish each other's thoughts, push back. But don't make a turn just "Wow." or "Yeah." on its own: fold one-word reactions into the start of the next real line ("Wow, okay, so how deep…"). Very short lines voice less reliably.
- **Hook in the first line.** No "Welcome back, today we're going to talk about". Start with the strangest true thing.
- **The co-host is the listener's proxy**: asks the obvious question, gets the number repeated in a way that sticks, says what everyone's thinking.
- **Numbers for the ear**: "about three and a half kilometres", not "3,505 m". One number per sentence. Compare to something familiar ("taller than three Eiffel Towers stacked").
- **Signpost**: "here's the weird part", "so what happened next", "the reason this matters". Recap the key fact at the end for people who tuned in mid-way.
- **Callbacks and running bits** (from the notebook) make it feel live and continuous.
- **Personas drive word choice**: the gruff chef never says "delightful"; the sceptic asks "says who?" and the expert names the source.
- **Credit the listener** when answering a request ("someone in the booth asked…").
- End most segments with a tease or a handoff ("after this: why Vikings had better teeth than you").

## 3. Delivery (ElevenLabs eleven_v3)
- Audio tags in square brackets steer delivery: emotion `[excited] [curious] [sarcastic] [nervous] [warmly] [deadpan]`, reactions `[laughs] [chuckles] [sighs] [gasps] [whispers] [clears throat]`, pacing `[pauses] [hesitates]`. One or two per line at most; they're seasoning.
- Ellipses (…) and dashes add natural pauses; CAPITALS stress a word; question marks lift the pitch. Spell out tricky names phonetically if needed ("Leung, that's 'lee-ung'").
- Tags are stripped automatically if the model falls back to `eleven_multilingual_v2`, so they never get read aloud.
- No markdown, emojis, URLs, or stage directions in plain text in the lines; everything in a line is spoken.

## 4. Segment shapes
| Shape | Length | Shape of it |
|---|---|---|
| Station open / ident | 10–25 s | name + tagline + tease; optional `radio jingle` first |
| Quick hits | 30–60 s | three sourced facts, rapid, one reaction each |
| Deep dive | 90–180 s | hook → context → the surprising bit → why it matters → recap → tease |
| Story (history) | 2–4 min | scene-setting → characters → turn → what happened next; co-host reacts and asks |
| Myth or fact? | 45–90 s | one host pitches a claim, the other rules on it with the source |
| News desk | 45–120 s | headline → what happened → context → what to watch; attribute every claim |
| Talk break (music) | 10–25 s | back-announce the last track, one fact, forward-announce; see radio-music |

Rough timing: ~150 spoken words per minute, so a 2-minute deep dive is ~300 words across all hosts.
