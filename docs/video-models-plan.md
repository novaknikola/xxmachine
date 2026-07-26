# Video models beyond Kling — plan

> Draft 2026-07-26. Companion to Copy-Paste image-model choice (Z-Image vs Seedream Edit).
> Today motion transfer / multi-shot video runs almost exclusively on **Kling v2.6 motion-control** via WaveSpeed.

## Have I heard of Seedance and LTX?

**Yes — both are on WaveSpeed already**, which matches our stack.

| Model | Maker | On WaveSpeed | Best for in our pipeline |
|-------|--------|--------------|---------------------------|
| **Kling 2.6 motion-control** (current) | Kuaishou | `kwaivgi/kling-v2.6-std/motion-control` | 1:1 body/camera motion from source video + character still |
| **Seedance 2.0** | ByteDance | `bytedance/seedance-2.0/image-to-video` (+ turbo / video-edit) | Cinematic **I2V** from keyframe + motion prompt; optional last frame; native audio |
| **LTX 2.3** | Lightricks | `wavespeed-ai/ltx-2.3/text-to-video` (+ LoRA, and I2V variants if listed) | Fast **T2V / prompt-driven** clips with synced audio; LoRA identity path |

They are **not drop-in Kling replacements** — different inputs, strengths, and technique fit.

---

## How they map to our techniques

| Technique (today) | Kling MC | Seedance I2V | LTX |
|-------------------|----------|--------------|-----|
| `motion_transfer` | **Best** (needs source video) | Weak (no true motion control) | Weak |
| `image_to_video` | Possible via MC w/ short ref | **Best** (image + prompt) | Good (prompt / I2V+LoRA) |
| `first_last_frame` | Partial | **Strong** (`image` + `last_image`) | Partial |
| `multi_shot` | Per-segment MC (current) | Per-segment I2V then stitch | Per-segment then stitch |
| `extend` | Limited by MC duration | Duration 4–15s turbo | Duration 5–20s |

**Rule of thumb**

- Need **exact dance / gesture copy** → keep Kling MC  
- Need **cinematic motion from a strong still** (our detailed scene prompt) → Seedance  
- Need **cheap/fast prompt or LoRA-driven clip** without source motion → LTX  

---

## Proposed product UX

Same pattern as the new **image model** select on Copy-Paste:

1. **Video model** dropdown (or auto-from technique with override):
   - `Auto (technique default)`
   - `Kling motion-control`
   - `Seedance 2.0 I2V` (+ Turbo toggle)
   - `LTX 2.3` (+ LoRA toggle when character has LoRA)
2. Persist on `discovery_items.video_model` (already exists as string audit field — normalize to enum-like values).
3. Optional profile default: `tracked_profiles.preferred_video_model`.

### Technique → default (Auto)

```
motion_transfer / multi_shot  → kling_mc
image_to_video                → seedance_i2v
first_last_frame              → seedance_i2v (with end frame)
extend                        → seedance_i2v or ltx (duration)
unknown / needs_review        → no auto-run
```

---

## Implementation phases

### Phase A — plumbing (small) ✅ implemented

- [x] `VideoBackend` type in `src/lib/monitor/video-backends.ts`
- [x] Technique → Auto default mapping
- [x] `generateReplicaVideo` dispatches by backend
- [x] UI select on Copy-Paste Replicate (next to image model)
- [x] Record chosen backend in `video_model` (`backend:modelPath`)
- [x] Unit checks: `npx tsx scripts/test-video-backends.ts`

### Phase B — Seedance I2V ✅ wired (live smoke pending)

- [x] Wire `bytedance/seedance-2.0/image-to-video` (and `-turbo`)
- [x] Inputs: keyframe, motion prompt, duration clamp 4–15, 9:16, optional `last_image`
- [x] Auto default for `image_to_video` / `first_last_frame` / `extend`
- [ ] Live smoke on 2–3 Discovery items (pre-deploy)

### Phase C — LTX ✅ wired (live smoke pending)

- [x] Wire `wavespeed-ai/ltx-2.3/image-to-video` + `image-to-video-lora`
- [x] UI options for both
- [ ] Live cost/quality compare vs Seedance on same keyframe

### Phase D — hybrid recipes (later)

- [ ] Seedream/Z-Image keyframe → Seedance I2V (layout + cinematic motion)
- [ ] Kling MC only when technique detector says motion_transfer with high confidence
- [ ] Optional: Seedance video-edit for light restyle of source clip (different product path)

---

## API sketch (WaveSpeed)

```text
Kling MC:     POST /api/v3/kwaivgi/kling-v2.6-std/motion-control
              { image, video, prompt?, ... }

Seedance:     POST /api/v3/bytedance/seedance-2.0/image-to-video
              { image, prompt, duration, resolution, last_image?, generate_audio? }

LTX:          POST /api/v3/wavespeed-ai/ltx-2.3/text-to-video
              { prompt, resolution, aspect_ratio, duration }
              (+ /text-to-video-lora with loras[])
```

Reuse existing `pollV3` in `src/lib/monitor/replicate.ts`.

---

## Risks / notes

- **Seedance ≠ motion control** — will invent motion from prompt; fine for UGC talking/walking, bad for exact choreography.
- **LTX LoRA** may not match our Z-Image LoRAs 1:1 (different base) — validate before promising identity.
- **Cost**: Seedance ~$0.50–0.70/gen class; LTX often cheaper at 480p/720p; Kling MC priced differently — surface estimate in UI later.
- **Audio**: Seedance/LTX can generate native audio; our pipeline often overlays original audio for Kling — decide per-backend.
- **Safety / NSFW**: each model’s checker differs; keep `enable_safety_checker` policy consistent where the API allows.

---

## Suggested order

1. Ship image-model choice (Z-Image / Seedream) — done in parallel with this doc  
2. Phase A + B (Seedance for I2V / FLF)  
3. Phase C (LTX)  
4. Auto routing by technique + user override  

When merging with a broader roadmap, keep **technique** (what the shot needs) separate from **backend** (which API runs it).
