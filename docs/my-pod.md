# My Pod — SSH + ComfyUI control plane

xxmachine is the **control plane**. Your RunPod GPU pod is an ephemeral worker.
You paste **only** the ComfyUI URL + SSH command from RunPod Connect. Outputs land in **Google Drive**.

UI: `/my-pod` (legacy `/comfyui` redirects here).

The RunPod SSH private key lives **on the xxmachine VPS** (`/root/.ssh/runpod_ed25519` or `MY_POD_SSH_PRIVATE_KEY`) — never typed in the dashboard.

## Architecture

| Layer | Role |
|-------|------|
| Dashboard `/my-pod` | Connection, Templates, Generate, Queue |
| `pod_sessions` | Encrypted SSH + Comfy credentials (24h TTL) |
| `generation_queue` | Job records (`comfyui_pod_bulk`, `my_pod_i2v`, `my_pod_animate`) |
| Cron `/api/cron/tick` | Claims jobs (1 concurrent My Pod job per user), session health probe |
| Worker (Next process route) | Drive download → SSH/Comfy → Drive upload |
| `workers/my_pod/` | Python Animate builder + optional I2V sidecar |

**SSH:** connect probe, disk check, mkdir, SFTP for large videos.  
**Comfy HTTP:** `/system_stats`, `/upload/image`, `/prompt`, `/history`, `/view`.  
**Drive:** input folders + final outputs.

## Setup

### 1. Database

```bash
npm run db:migrate
```

Applies `033_my_pod_sessions.sql`.

### 2. Templates on the VPS

Already under `workers/my_pod/templates/` (or set env overrides):

| File | Purpose |
|------|---------|
| `Wan22_I2V_api_template.json` | API-format I2V graph |
| `Wan22_Animate.json` | UI-format Animate workflow for `build_api.py` |

Env overrides:

- `MY_POD_I2V_TEMPLATE_PATH`
- `MY_POD_ANIMATE_WORKFLOW_PATH`
- `MY_POD_PYTHON` (default `python3`)

### 3. Pod checklist

Pod must have ComfyUI listening (usually port 8188) with models + custom nodes for the workflow you run:

**Simple templates:** whatever nodes your saved API JSON needs.

**I2V:** WAN 2.2 I2V checkpoint, VHS, matching node IDs in the API template.

**Animate:** WAN 2.2 Animate 14B, DWPose, SAM2, KJNodes / SDPose face crop nodes, 32GB+ VRAM recommended.

Network volume `/workspace` for models is fine; session `remote_work_root` defaults to `/workspace/xxmachine`.

### 4. Connect in UI

1. Open **My Pod → Connection**
2. Paste **ComfyUI URL** from RunPod Connect (HTTP Services → comfy / 8188)
3. Paste the full **SSH** line from RunPod Connect
4. Click **Connect**

Nothing else is typed. The VPS uses `/root/.ssh/runpod_ed25519` (or `MY_POD_SSH_PRIVATE_KEY`) for SSH.

## Job modes

### Simple (API templates)

- Save Comfy **API-format** JSON in Templates tab (prompt node + optional image node)
- Generate → Simple → prompts + Drive folders
- Stages: `validating` → `uploading` → `running` → `downloading` → `done|error`

### WAN I2V (`my_pod_i2v`)

- Drive input folder: flat images
- Optional prompt override (default subtle motion prompt)
- One video per image → output folder

### WAN Animate (`my_pod_animate`)

- Drive input folder: **one** reference image + N driving videos (flat)
- Python `build_api.py` + `animate_run.py` against remote Comfy
- Stages include `building_graph` / `running_windows`

## Timeouts & watchdog

| Event | Behavior |
|-------|----------|
| Session TTL | 24h (extend on successful Test) |
| Cron health | Re-probe Comfy (SSH if HTTP fails) each tick |
| Queue UI refresh | 5s while active |
| No progress (stuck early stage) | Fail after ~10 min |
| Wall clock My Pod job | Fail after 90 min |
| Network upload/download | One retry |
| Comfy OOM / node error | Item failed, batch continues |

## Error expectations

Jobs always end `done` or `failed` with an actionable message. Pod death mid-run → fail on next health/history poll — not a silent hang.

## Related code

- Session: `src/lib/my-pod/session.ts`, `src/app/api/my-pod/session/`
- Comfy/SSH: `src/lib/my-pod/comfy.ts`, `ssh.ts`
- Runners: `src/lib/my-pod/runners.ts`
- Workers: `workers/my_pod/`
- Queue: `src/app/api/queue/submit/route.ts`, `process/[id]/route.ts`
- Cron: `src/app/api/cron/tick/route.ts`

## Out of scope

Serverless RunPod API, auto-start pods, LTX/InfiniteTalk, Fish Audio mux, shared pod farms.
