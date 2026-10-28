---
name: radio-research
description: How Claude Radio finds things worth saying — real web research for each segment (WebSearch / WebFetch), choosing angles that make a listener say "huh!", verifying facts across sources, keeping citations for the tuner, and a station notebook so nothing repeats. Use before writing any factual segment, when the user asks "is that true?", or when a station needs fresh material.
---

# Research for radio

You have real research tools: **WebSearch** for finding, **WebFetch** for reading the page. Use them for every factual segment. Your own knowledge is for choosing angles and spotting nonsense, not for un-sourced claims on air.

## 1. Pick the angle first (30 s)
- Check the notebook: `radio notes` and `radio aired --n 20`. Skip covered ground; look for follow-ups and leads noted earlier.
- A good radio angle is **one surprising, specific thing** plus why it matters: "an octopus edits its own RNA to survive cold water", not "octopuses are smart".
- For "today" stations: search for news from the last 24–48 h (put the date or "this week" in the query), and prefer primary reporting (wire services, the organisation's own announcement, the paper itself) over aggregators.
- For evergreen stations (history, science, oddities): look for recent papers/finds that re-open an old story, anniversaries ("on this day"), museum and archive pages, university press releases.

## 2. Search → read → verify
1. 1–3 WebSearch queries. Skim results for the strongest 2–3 sources.
2. WebFetch the best page(s) and pull the specifics: names, dates, numbers, a quote, the vivid detail.
3. **Verify** every claim that carries the segment against a second independent source. Numbers and dates especially. If sources disagree, that disagreement is content: the hosts can say so.
4. Grade it: *documented* (say plainly) · *reported/claimed* (attribute: "according to…") · *legend/rumour* (only as legend, and say so) · *unverified* (leave it out).
5. Keep it moving: a quick-hits segment is ~2 searches; a deep dive maybe 4–6 fetches. If a thread is a dead end after two tries, pick another angle rather than burning the buffer.

## 3. Sources on air
- Every segment script lists its sources: `# source: Title | https://url` (several lines or `;`-separated). They appear in the tuner's Sources panel while it airs.
- Hosts can name sources naturally ("a paper in Nature this month…", "the BBC's reporting…") but never read URLs aloud.
- Don't quote long passages; paraphrase in the hosts' own words (a short attributed quote is fine).

## 4. The notebook (memory across sessions)
After each segment airs (or is queued), record it:
```bash
node radio.mjs notes add "covered: Antarctic octopus RNA editing — edits ~60% of neural transcripts in cold (Cell 2017; Science News)"
node radio.mjs notes add "lead: same lab now studying squid; check for 2026 follow-up"
node radio.mjs notes add "running bit: Rhys refuses to believe anything about octopuses"
node radio.mjs notes add "listener: asked for more space weather"
```
Prefixes: `covered:` · `lead:` · `running bit:` · `listener:` · `avoid:`. Read the notebook at the start of every session on a station.

## 5. Background researchers
For deep dives, a background research agent can prep while the current segment airs (see radio-on-air). Give it the station brief, the exact angle, the notebook's `covered:` lines to avoid, and ask for: verified facts with URLs, one surprising hook, anything disputed, and suggested follow-up leads. Check its sources before airing anything that sounds too good.
