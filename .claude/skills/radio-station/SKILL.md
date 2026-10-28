---
name: radio-station
description: Design and build a new Claude Radio station from a prompt — name, frequency, format (talk / music / mixed), brief, a cast of ElevenLabs voices with personas, and a show clock — then tune to it. Use when the user (or the tuner's "type your own station" box) asks for a station that isn't on the dial, wants to change a station's hosts or format, or invokes /radio-station.
---

# Build a station from a prompt

The prompt can be anything: "two grumpy chefs on the history of food", "AI news but chill", "Cantopop and Hong Kong film trivia", "my commute: hardstyle with traffic-light facts". Turn it into a station that can run for hours without getting repetitive.

## 1. Design (in your head, ~30 s; don't ask questions unless the prompt is unusable)
- **Name** that sounds like a real station (2–3 words, no "AI"), **tagline** under 8 words.
- **Format**: `talk` (hosts only) · `music` (Claude DJ plays; hosts do short breaks) · `mixed` (songs between longer talk pieces). Anything mentioning songs, a genre or "music" → music or mixed.
- **Brief** (2–4 sentences): what it covers, the research beats (where facts come from: news, papers, archives, the crate), tone, and anything it never does.
- **Hosts** (1–3; 2 is the sweet spot for talk): name, `voice`, role, persona (one line: background, attitude, how they talk). Personas should contrast (expert vs. curious newcomer, enthusiast vs. sceptic) so the banter has a reason to exist.
- **Clock**: 4–7 recurring segment types in rotation (see the presets in `stations/*.json` for shape).
- **Music** (music/mixed only): `{ "brief": "genre, era, BPM range", "talk": "how often and how long hosts talk" }`.

## 2. Cast the voices
```bash
node radio.mjs voices            # all account voices with labels (accent, age, style)
node radio.mjs voices british    # filter
```
- `voice` can be the short name (`George`), the full name, or the voice id. Prefer voices whose labels fit the persona (narrative_story for storytellers, informative_educational for explainers, conversational for banter, an Australian accent where it fits).
- Contrast is key: two hosts with different gender, accent or energy are much easier to follow by ear.
- Don't reuse a voice that's already a host on another station the user listens to a lot, unless it fits (a station "personality" crossover can be fun if it's intentional).
- The user's own cloned voices (category `cloned` / `professional` with their name) only when they ask for them.

## 3. Create and tune
```bash
node radio.mjs station create - --tune <<'EOF'
{
  "name": "Mise en Place",
  "tagline": "food history, argued over",
  "format": "talk",
  "prompt": "two grumpy chefs on the history of food",
  "brief": "The real histories of dishes, ingredients and kitchens, from food historians, museum collections and academic sources. Two veteran chefs who disagree about everything except the facts. Myths get busted on air, with sources.",
  "hosts": [
    { "name": "Bruno", "voice": "Bill", "role": "chef", "persona": "old-school, gruff, romantic about tradition, secretly soft" },
    { "name": "Dee", "voice": "Laura", "role": "chef", "persona": "modernist, sharp, loves a myth-bust, laughs at Bruno" }
  ],
  "clock": ["cold open argument (20s)", "the dish: real origin story (2-3 min)", "myth or fact?", "station ident", "ingredient deep cut", "what we'd cook tonight"]
}
EOF
```
- `freq` is optional (a free one is picked); `id` defaults to a slug of the name. Custom stations live in `.radio/stations/` and stay on the dial.
- Changing a station later: `radio station <id>` → edit the JSON → `radio station update -`. On air, have the hosts mention the change ("joining us from today…").

## 4. Then go on air
Straight into **radio-on-air**: open first (hosts introduce the new station and what it's about, no research needed), research while it plays.
