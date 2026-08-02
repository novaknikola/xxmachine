# Repurpose variants — parked plan

> Draft 2026-07-29. Points 3 and part of 1 are shipped; the rest is parked.
> Nothing in production behaves differently yet — see "Current state".

## Problem

`repurposeImageUrls` produced exactly **one** `ready/` file per source image. It was a
uniqueness pass to defeat platform duplicate detection, not a multiplier. There was no way
to ask for N postable assets out of one generation, and no way to make those assets look
different from each other.

## Current state (shipped)

| Change | File |
|---|---|
| Source is downloaded and probed **once** per image; only ffmpeg repeats per variant | `image-repurpose.ts` |
| `repurposeImageUrls({ variants })`, retry now per variant, `skipped` counts correctly | `image-repurpose.ts` |
| Dead `ImageRepurposeProfile.count` field wired up as the default variant count | `repurpose-profiles.ts` |
| `dedupe` / `distinct` strength profiles | `repurpose-profiles.ts` |
| Rotation, midtone colour balance, tone-curve presets for `distinct` | `image-repurpose.ts` |
| `maxKeepForRotation` — crop clamps so rotation never leaves black corners | `image-repurpose.ts` |
| `centerBias` — keeps large crops near centre so they cannot behead the subject | `image-repurpose.ts` |
| Smoke test, writes files for eyeballing, no Supabase/Drive needed | `scripts/test-image-variants.ts` |

```
npx tsx scripts/test-image-variants.ts <jpeg> [dedupe|distinct] [outDir]
```

**No caller passes `strength` or `variants` yet**, so every path still gets `dedupe` with
one variant — byte-for-byte the old behaviour. Wiring is a deliberate later step.

## Measurements that drive the rest

- **520–1230 ms per variant** (ffmpeg, 720×1280 source).
- Repurpose runs **inline inside `persistGeneration`**, before the API responds. At
  `count: 3` that is 3× the wait on every generation.
- Current `ready/` path is `provider → server → ffmpeg → Supabase Storage → server → Drive`.
  Two hops more than needed.
- `readyUrls` is consumed **only** by `enqueueDriveArchive`. No client reads it —
  verified across `src/`.

## Remaining work, in order

### A. Move repurpose into the Drive worker  ← needs a go/no-go
`processOne` in `drive-archive/process.ts` already downloads the source buffer before
uploading. When `row.stage === 'ready'` and the MIME is an image, apply the transform to
that buffer and upload the result.

- Enqueue `ready` rows pointing at the **original** URL; the variant index already lives in
  the filename, and `stage` already distinguishes raw from ready — **no migration needed**.
- Drops the Supabase write for ready variants entirely.
- `persistGeneration` stops returning `readyUrls` (safe — nothing reads it) and returns
  immediately instead of blocking on ffmpeg.
- Trade-off: `ready/` files appear when the worker reaches them, not at generation time.

### B. Expose the choice
- Per-generation: variant count + `dedupe`/`distinct`.
- Per-user default in Settings — matters more than the per-run control at volume.
- Possibly per content format: stories tolerate a stronger grade than carousels, where
  slides sit side by side and must stay cohesive.

### C. Filenames
`buildArchiveFilename` already appends `_${index+1}` for multi-image generations. Add
`_v${variant+1}` alongside it. Flat inside `ready/`, no sub-folders — easier for a VA to drag.

### D. Video symmetry
`repurposeVideoUrls` is still 1:1 with its own profile set. Same treatment, but only after
the image path proves out.

## Separate but related: `driveFolder` vs `characterName`

`generate-tab.tsx` and `bulk/page.tsx` have a "Drive folder (girl)" input. It is sent as
**`characterName`**, so it lands in `generations.character_name` and pollutes History and the
ZIP export folder naming. Setting it to `test-batch` makes History claim the character is
`test-batch`.

Fix: add a dedicated `driveFolder` to `PersistGenerationInput`, and resolve as

```ts
characterKey = driveFolder?.trim() || characterName?.trim() || characterId?.trim() || '_none'
```

Then the same optional override can safely appear on single-image generation too.

## Already fixed on the way here

`_unsorted/` was being created because `reels/page.tsx` posted to `/api/generate` without
`characterId` / `characterName` even though both were in scope. Also hardened
`persist-generation.ts:52` — `??` let an empty-string name beat a valid id.
