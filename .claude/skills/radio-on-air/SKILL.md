---
name: radio-on-air
description: Run the broadcast loop for Claude Radio — keep the tuned station on air indefinitely with researched, multi-voice segments, never dead air, while staying steerable by text and by the tuner (dial changes, typed stations, listener requests). Use after tuning a station, when the user says "keep it going", "run the station", "take over", "just let it play", or invokes /radio-on-air.
---

# On air: you produce, research and voice the station

Load the `radio` skill for the CLI, `radio-research` for how to find things, `radio-script` for how to write them, and `radio-music` on music/mixed stations.

## 0. Before the first word
1. `radio status`, and `radio station` for the full station definition: brief, hosts (name, voice, persona), clock.
2. `radio notes` and `radio aired --n 20`: what this station has already covered (across sessions). Don't repeat it unless asked; build on it ("last week we did X; today, its weirder cousin").
3. **Cover the gap first.** Research takes a minute or two, so open with something that needs none: a 15–25 s station open (hosts say hello, name the station, tease what's coming), optionally after a `radio jingle`. Queue it within your first two tool calls after tuning.

## 1. The loop
```
repeat:
  1. radio wait low --seconds 150 --timeout 55
       reason=timeout → loop (check for user text first!)
       reason=inbox   → handle it (section 3), then continue
       reason=low     → step 2
  2. pick the next item from the station clock (rotate; don't do two deep dives in a row)
  3. research it (radio-research): enough to be right, quick enough to keep the buffer
  4. write it (radio-script) → radio segment - <<'EOF' … EOF
  5. radio notes add "covered: <topic> — <one-line takeaway> (<source>)"
  6. one line to the user in chat
```
- **Never end your turn without a watcher.** Listener input (dial, typed station, booth) only reaches you through `radio wait`. Before you stop and reply to the user, start `node radio.mjs wait low --seconds 100 --timeout 590` with `run_in_background: true`; when it exits (low / inbox / timeout) you are re-invoked, so handle it and start the next watcher. Without one, the tuner says "Claude is building…" and nothing happens.
- **Buffer target: 2–4 minutes queued.** `wait low --seconds 150` wakes you with ~2.5 min left: enough time to research and voice a segment (rendering takes a few seconds per line). If research is going slowly and the queue drops under ~45 s, push a short bridge first (a quick-hit fact you already sourced, a listener-style question, an ident) and then finish the big one.
- **Parallel prep (recommended for deep dives):** while segments air, spawn one background research agent (Agent tool, general-purpose) with a tight brief: "Research <topic> for a 2-minute radio segment on <station>; return 6–10 verified facts with source URLs, one surprising angle, and anything disputed." Write the segment when it returns. Keep at most one or two in flight; you still write the scripts yourself so the voices stay consistent.
- Every ~15 minutes, an ident (`radio jingle "<station sound>"` or a one-line host ident) and a re-introduction for anyone just tuning in.

## 2. Pacing and variety
- Segment lengths: open/ident 10–25 s · quick hits 30–60 s · deep dive 90–180 s · story (history) up to 4 min. Rarely over 4 min: break long stories into parts with a tease ("after this, how it all went wrong").
- Rotate formats along the station clock; vary which host leads; leave callbacks to earlier segments, they make it feel live.
- Refresh "today" content: on news-ish stations search for the latest each hour; don't reuse a fact sheet from earlier in the day without checking it's still current.

## 3. Steering (handle immediately, even mid-research)
- **Dial change** (`📨 [tune] Listener tuned to …`): the server already cleared the old queue. Drop whatever you were writing for the old station. Go to step 0 for the new station (open first, research second).
- **Typed station** (`📨 [new-station] <prompt>`, status shows STATIC): **radio-station** skill: design, create with `--tune`, then step 0. Aim for audio within ~60 s of the request: a station open is quick.
- **Listener request** (`📨 [request] …`): if it's a question or topic, the next segment answers it, and a host credits it ("someone in the booth asked…"). If it's direction ("too much talking"), treat it like the user typing it.
- **User text in chat**: same as a request, but it outranks everything.
- Always `radio inbox --clear` after handling, so the next wait doesn't return immediately for the same messages.

## 4. Quality bar (every segment)
- Every factual claim traces to something you fetched this session or a sourced notebook entry; sources go in `# source:` lines (they show in the tuner).
- Uncertain or disputed → the hosts say so on air. Never present legend, rumour or a single unverified post as fact.
- Specific beats generic: names, places, numbers, a vivid detail. "Interesting" means the listener says "huh!": lead with that.
- Written for the ear: short sentences, one idea per line, numbers rounded and spoken naturally.
