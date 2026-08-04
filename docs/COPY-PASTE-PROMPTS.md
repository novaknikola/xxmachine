# Copy-Paste: every prompt and condition

Written so a bad result can be diagnosed by reading rather than by paying for
another render. Everything here is transcribed from the code — file and symbol
named at each step, so it can be checked against source rather than trusted.

The pipeline:

```
reel → frames + transcript → analysis JSON (spec) → keyframe prompt → Seedream Edit
                                                  → video prompt    → Seedance 2.0
```

Two separate prompts come out of one spec. They are built by different
functions and only one of them was ever visible in the UI.

---

## 1. Sampling — what the analyser is allowed to see

`src/lib/monitor/analyze.ts` · `probeSourceVideo`

| | |
|---|---|
| Frames | `ceil(duration / 1.2)`, floor 8, ceiling 20 |
| Grid | evenly spaced from `min(0.4, 5% of duration)` to `duration − 0.25` |
| Extra frames | one at the **middle of each spoken line** from the transcript |
| Dropped | a line time already within half a grid step of an existing frame |
| Scene cuts | detected separately (`detectSceneCuts`), not part of the frame budget |

Real spacing:

| Clip | Grid frames | Gap |
|---|---|---|
| 7s | 8 | 0.91s |
| 10s | 9 | 1.17s |
| 15s | 13 | 1.20s |
| 20s | 17 | 1.21s |
| 30s | 20 | 1.54s |

Past ~25s the gap widens again — the 20-frame ceiling exists because every
frame rides in a single vision call, and a model's attention per image drops as
the count rises.

**All frames go to one call.** Model `GROK_SMART`, `temperature: 0.2`,
`maxTokens: 4096`.

---

## 2. Analysis call — what is sent alongside the frames

`src/lib/monitor/copy-paste-spec.ts` · `extractCopyPasteSpec`

After the images, one text block:

- `These N frames are sampled in chronological order from one Reel.`
- `Each frame's exact time in the clip, in order: 0.4s, 1.6s, …` — 0.1s precision
- `Measured from the source file: duration Xs, aspect ratio Y.`
- `Use these exact numbers in "format" — do not invent your own duration or aspect ratio.`
- The transcript, if speech was found, introduced as: *the speaker is NOT
  labelled — you must work out who is talking using RULE D*
- `Fill the JSON completely, following RULE A (reference lock), RULE B (normalization) and RULE D (speech attribution) exactly.`

---

## 3. The system prompt — the rules the analyser follows

`COPY_PASTE_SYSTEM`. It asks for one JSON object with these keys:

`format`, `people[]` (`id`, `role`, `appearance`, `wardrobe`), `environment`,
`lighting`, `color_grading`, `atmosphere`, `audio`, `pacing`,
`background_activity`, `scene_events[]` (`timestamp`, `speaker`, `line`,
`delivery`, `action`), `style`, `camera_logic`, `imperfections[]`, `shots[]`,
`end_behavior`, `negative_prompt`.

### RULE A — reference-locked identity

`people[0]` is the person the reference photo replaces. For that person only,
`appearance` is forced to a fixed string and nothing else:

> reference character is from image. Mature \<woman or man\>, realistic facial
> features, highly detailed.

No hair colour, skin tone, ethnicity or age words are allowed in `appearance`.

**Hair.** RULE A says, verbatim:

> Their "wardrobe" field describes CLOTHING ONLY — garments, colors, fabrics,
> footwear, accessories. Write NOTHING about their hair: no color, no length, no
> style, no texture. The hair comes from the reference photo, and describing the
> source person's hair here overrides it. This applies to people[0] only.

It used to say the opposite — that hair is "a styling choice, not a
facial-identity attribute", and belonged in `wardrobe`. Since `wardrobe` is
passed straight into the keyframe prompt (§5), the analyser was describing the
**source reel's** hair and that text was beating the reference photo. Hair is
now excluded here and named in `KEYFRAME_IDENTITY_LOCK` instead.

The character's own `hairLock` field (`src/lib/types.ts`) is still unused by
this pipeline — it is read only by `buildCharacterStylePrefix`, which is never
called here. It remains the option to take if hair should be fixed per
character rather than per reference photo.

### RULE B — normalization (`NORMALIZATION_RULES`)

Applied to **every** person in the scene, not only the locked one:

- Hair reading as pink or any dyed/fantasy tone → describe as hair only. Never
  write "pink hair", "red hair", "ginger hair", "blonde hair" for anyone.
- Garment reading as pink → describe as white. Never "pink" as a wardrobe colour.
- Never write "Asian" or any specific Asian ethnicity → describe as European.
- Never "black skin" / "dark skin" → describe skin tone as white/fair.
- Never "young", "girl", "teenager", "child", or any age-of-minor language.
  Everyone must read as a mature adult (late 20s or older), rewriting the whole
  age impression rather than swapping one word.

### RULE C

The model must return `negative_prompt` as an empty string. Our code always
overwrites it — see §4.

### RULE D — speech attribution

The transcript carries no speaker labels and the camera operator is usually not
in frame.

- A line may be attributed to a person only if that person is visible **and**
  their mouth is open / mid-speech in the frame nearest that line's timestamp.
- If the nearest frame shows them silent, listening, reacting or facing away →
  `speaker` is exactly `offscreen`.
- If the transcript reads as back-and-forth but only one person is ever visible,
  the second voice **is** offscreen. Never hand both halves to one person.

This rule is why frames are now also sampled at line times (§1) — the rule asks
a question that an evenly spaced grid often had no frame to answer.

---

## 4. Negative prompt — always ours, never the model's

`NEGATIVE_PROMPT_TEMPLATE`, overwritten after parsing:

> no smooth gimbal motion, no cinematic stabilization, no professional lighting,
> no beauty filter, no AI skin smoothing, no young girl, no young woman, no
> teenager, no child, no perfectly centered framing, no overly dramatic acting,
> no slow motion, no music video energy, no drone footage feel, the on-camera
> subject does not speak other people's lines, no lip-syncing to off-screen
> dialogue, no mouthing words spoken by someone behind the camera, no tattoos,
> no visible body ink, no piercings not present on the identity reference

---

## 5. Keyframe prompt → Seedream v5 Pro Edit

`renderKeyframeEditPrompt`. Image 1 is the source frame, image 2 is your
reference photo. Assembled in this order:

1. `Image 1 is the scene reference, image 2 is the identity reference.`
2. `Keep the exact pose, camera framing, and background from image 1 unchanged.`
3. `Replace the main subject's face and body identity with the person from image 2.`
4. `Wardrobe: {people[0].wardrobe}.` ← source reel's clothing, **no hair**
5. `Environment: {spec.environment}.`
6. `Lighting: {spec.lighting}.`
7. `Body and skin come from image 2, not image 1: {KEYFRAME_IDENTITY_LOCK}.`
8. `Photorealistic, natural skin texture, no beauty filter, no AI skin smoothing.`
9. `Do not add any other people. Do not change the composition, angle, or background.`
10. `Avoid: {negative_prompt}.`

`KEYFRAME_IDENTITY_LOCK`:

> hair colour, hair length and hairstyle, body proportions, bust size, build,
> skin tone and skin markings all follow image 2; do not copy the hair, tattoos,
> piercings, scars, birthmarks or body shape from image 1

Lines 4 and 7 are the pair that decides appearance. Line 4 carries only what
should come from the scene (clothing), line 7 names everything that must come
from the identity photo. Hair sat on the wrong side of that split until
2026-08-04.

The end keyframe (`renderEndKeyframeEditPrompt`) is chained rather than
independent — image 3 is the already-rendered start keyframe, and appearance is
pinned to it, so the two ends cannot drift apart.

Both prompts are stored per item (`discovery_items.keyframe_prompt`,
`end_keyframe_prompt`) and shown read-only in **Details**.

---

## 6. Video prompt → Seedance 2.0

`renderCopyPastePrompt`, flattened into one prose string in this order:

`format` → one line per person (`id: role. appearance. wardrobe.`) →
`environment` + `Lighting:` + `Color grading:` + `Atmosphere:` + `Pacing:` +
`Background:` → `Audio:` → scene events → `style` / `camera_logic` →
`imperfections` → shots → `end_behavior` → `Avoid: {negative_prompt}.`

**Speech is filtered here, not trusted from the model.** Only a `speaker` that
matches an id in `people[]` keeps its quoted line. Anything the model could not
pin to a visible person — `offscreen`, `none`, an unknown name — is reduced to
an unquoted mention, so Seedance has no text to lip-sync onto the on-camera
subject. RULE D asks for this; this step enforces it regardless of the answer.

This is the prompt shown as **Rendered prompt** in Details, and it is
**editable** — a manual edit always wins over a freshly rendered one.

---

## 7. Where to intervene

| Symptom | Read | Change |
|---|---|---|
| Wrong hair | line 7 in the keyframe prompt; check `Wardrobe:` mentions no hair | `KEYFRAME_IDENTITY_LOCK`, or wire `hairLock` for a per-character lock |
| Tattoos / body | line 7 + `Avoid:` in the keyframe prompt | `KEYFRAME_IDENTITY_LOCK` |
| One speaker gets all lines | `scene_events[].speaker` in the spec | RULE D, or denser frames at line times |
| Wrong action | `shots[]` and `scene_events[].action` | frame density |
| Anything in the video only | Rendered prompt in Details | edit it directly and re-run |

Editing the Rendered prompt does **not** change the keyframe — that is rebuilt
from the spec on every render. To move the image, change the spec fields the
keyframe draws from: `wardrobe`, `environment`, `lighting`.
