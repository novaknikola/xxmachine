# RunPod + ComfyUI remote worker — plan & instructions

> **Superseded for implementation by [`docs/my-pod.md`](./my-pod.md).**  
> My Pod (SSH + ComfyUI URL + Drive) is implemented under `/my-pod`. Keep this file as historical design notes.

> Draft 2026-07-27. Parking doc — **implementation lives in My Pod**. Return to my-pod.md for ops.
> Goal: user starts a RunPod pod with ComfyUI, sends credentials to xxmachine, and our server orchestrates generate → folders on drive → outputs placed automatically.

---

## Product intent (one sentence)

xxmachine is the **control plane**; RunPod+ComfyUI is an **ephemeral GPU worker**; drive (or object storage) is the **source of truth** for inputs/outputs.

---

## Success definition

1. User pastes RunPod SSH + ComfyUI base URL (and optional token) once per session/pod.
2. System validates connectivity (SSH + Comfy health).
3. For each job: create `…/{userId}/{jobId}/input` and `…/output`, upload inputs, queue Comfy workflow, poll to completion, download outputs into `output/`, mark job done/failed with clear error.
4. Pod death / network blip → job fails cleanly or retries once; UI never hangs forever.

**Non-goal (v1):** auto-provisioning RunPod billing accounts, multi-tenant shared pods, or “set and forget 24/7 without monitoring.”

---

## Architecture (v1)

```
[User browser / Studio UI]
        │  credentials + “Run on my RunPod”
        ▼
[xxmachine API / queue]
        │  job record (queued → … → done|failed)
        ▼
[Worker process — Python preferred for Comfy ecosystem]
        ├── SSH (Paramiko / asyncssh): mkdir, scp/rsync inputs, check disk
        ├── HTTP(+WS): ComfyUI /prompt, /history, /view, optional /ws
        └── Storage: write final files to Drive mount or S3-compatible bucket
```

**Why Python worker (not only Node):** Comfy community scripts, websocket clients, and workflow JSON tooling are denser in Python; Next.js stays for auth, UI, job API, and credential vault.

**Where it runs:** same VPS / machine that hosts xxmachine (or a sibling worker container with access to DB + drive mount). Not inside the user’s RunPod (control plane must outlive the pod).

---

## Credentials model

| Field | Purpose | Notes |
|-------|---------|--------|
| `ssh_host` | RunPod SSH endpoint | Often `*.proxy.runpod.net` + port |
| `ssh_port` | SSH port | RunPod proxy port ≠ 22 sometimes |
| `ssh_user` | Usually `root` | Confirm per template |
| `ssh_private_key` or password | Auth | Prefer key; encrypt at rest |
| `comfy_base_url` | e.g. `https://….proxy.runpod.net` | Must reach `/system_stats` or `/object_info` |
| `comfy_api_token` | If template enables auth | Optional |
| `remote_work_root` | e.g. `/workspace/xxmachine` | Created if missing |
| `drive_root` | Server-side path | e.g. `/data/users/{userId}/comfy` |

**Rules**

- Never log raw keys.
- Encrypt secrets (same pattern as other user API keys in the app).
- Credentials are **session-scoped** (expire when pod stops or after N hours); do not assume permanent.
- On save: run **validation probe** before accepting.

**Validation probe (must pass)**

1. TCP/SSH connect + `uname -a` (or `echo ok`).
2. HTTP GET `{comfy_base_url}/system_stats` (or `/object_info`) → 200.
3. Ensure remote disk free space > threshold (e.g. 5 GB).

---

## Folder layout

**On server (drive / volume) — source of truth**

```
{drive_root}/
  {userId}/
    {jobId}/
      input/          # what we send to Comfy
      output/         # finals user sees
      meta.json       # workflow id, timings, errors, remote paths
      workflow.json   # snapshot of graph used (audit)
```

**On RunPod (ephemeral)**

```
{remote_work_root}/{jobId}/
  input/
  output/             # Comfy output_directory or Copy nodes target
```

After success: copy remote `output/*` → server `output/`, then optionally delete remote job dir to free VRAM/disk.

---

## Job state machine

```
queued
  → validating_credentials
  → preparing_folders
  → uploading_inputs
  → submitting_prompt
  → running            (poll history / websocket progress)
  → downloading_outputs
  → completed
  → failed             (terminal; message + last stage)
```

**Timeouts (starting points — tune later)**

| Stage | Timeout |
|-------|---------|
| SSH connect | 30s |
| Comfy health | 15s |
| Upload | 10–30 min (size-dependent) |
| Comfy run | 5–45 min (workflow-dependent) |
| Download | 10–30 min |
| No progress heartbeat | 5–10 min → fail or soft-retry |

**Retries**

- Network / SSH drop during upload or download → retry that stage **once**.
- Comfy OOM / CUDA error → **do not** blind-retry same settings; fail with hint.
- Pod gone (SSH refuse) → fail: “Pod offline — start RunPod and reconnect.”

---

## ComfyUI integration notes

1. Prefer **API-format workflow JSON** (`/prompt` body), not only UI “Save”.
2. Map input files to expected node widget names / paths under Comfy `input/` or absolute path under `remote_work_root`.
3. Collect outputs via `/history/{prompt_id}` → `/view?filename=…&subfolder=…&type=output`.
4. Optional: websocket for progress % in UI later; v1 can poll history every 2–5s.
5. Pin **template image + custom nodes** list in docs for users (“supported RunPod template”); unsupported nodes = predictable failures.

---

## xxmachine product surfaces (later)

1. **Settings / Integrations:** “My RunPod” — paste SSH + Comfy URL, Test connection.
2. **Job action:** “Generate on my GPU” vs existing WaveSpeed path (keep WaveSpeed default).
3. **Status:** stage + last error; link to `output/` when done.
4. **No silent billing:** user owns RunPod cost; we only orchestrate.

---

## Implementation phases (when we return)

### Phase 0 — Spike (1–2 days)

- Manual: one RunPod Comfy template, SSH + curl `/system_stats`.
- Python script: connect SSH, mkdir, upload one image, submit fixed workflow, download one PNG.
- Document exact template ID and paths that worked.

### Phase 1 — Worker MVP

- Python service + Redis/DB job queue (or reuse existing `generation_queue` pattern).
- Encrypt credential store.
- State machine + folder layout on server disk (skip Google Drive sync first if flaky — local/NFS/S3 first).
- One hard-coded workflow (e.g. img2img or simple checkpoint).

### Phase 2 — App wiring

- API routes + minimal UI for credentials + start job.
- Show stages in Copy-Paste or a dedicated “GPU worker” tab.
- Map user inputs (face refs, scene still) into workflow placeholders.

### Phase 3 — Hardening

- Heartbeat / cancel job / disconnect pod.
- Per-user concurrency = 1 on their pod.
- Metrics: success rate, fail reasons, p50/p95 duration.
- Optional: rsync instead of SFTP for large files.

### Explicitly later

- Auto-start RunPod via RunPod API (needs user’s RunPod API key).
- Multi-workflow marketplace.
- Shared farm of pods (ops nightmare — avoid early).

---

## Reliability expectations (honest)

| Scenario | Expected |
|----------|----------|
| Happy path, stable pod | High success |
| Overnight unattended, idle pod timeout | Failures unless watchdog + user keeps pod warm |
| Random custom nodes / missing models | Frequent fail until template is locked |
| Drive sync as live mount | Extra flakiness — prefer copy-in/copy-out |

Target after Phase 3: **most jobs complete or fail with a clear, actionable error** — not “zero interruptions.”

---

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Secrets leak in logs | Redact; encrypt; short-lived sessions |
| Hung Comfy job | Heartbeat + cancel via Comfy interrupt API if available |
| Disk full on pod | Pre-check + cleanup old `{jobId}` dirs |
| User pastes HTTP UI URL that isn’t API | Validation probe; help text with example |
| Mixing WaveSpeed and RunPod paths | Separate job type / status; don’t share one pipeline blindly |

---

## Open decisions (resolve when we resume)

1. Storage: local volume vs S3 vs Google Drive mount?
2. Queue: new Python worker queue vs extend existing Node `generation_queue` that shells out?
3. First workflow: which Comfy graph (identity / I2V / upscale)?
4. Is RunPod API auto-start in scope for v1 or credentials-only?

---

## Resume checklist (next session)

- [ ] Confirm storage choice (#1)
- [ ] Confirm first workflow (#3)
- [ ] Run Phase 0 spike on a real pod; paste working host/path notes into this doc
- [ ] Then implement Phase 1 worker only — no UI until spike is green

---

## Related

- Current generation path remains WaveSpeed (`src/lib/monitor/replicate.ts`, queue process routes).
- This plan is an **optional parallel backend**, not a replacement for WaveSpeed in v1.
