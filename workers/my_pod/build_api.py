"""
Builds an API-format ComfyUI prompt for the WAN 2.2 Animate workflow, chaining
N "Video Extend" windows to cover a driving video of arbitrary length, with a
real face crop feeding face_video (instead of the template's default DWPose
skeleton render, which starves the model of mouth detail).

Run on the ComfyUI pod itself (needs the local /object_info API and the
workflow template file). Configure via environment variables so the same
script works for any image/video pair without editing:

  IMAGE_FILE        filename already present in ComfyUI/input/ (default: ref3_image.png)
  DRIVING_FILE      filename already present in ComfyUI/input/ (default: ref3_driving.mp4)
  DRIVING_FRAMES    total frame count of the driving video, used to pick window count (default: 362)
  FPS               output fps (default: 30)
  SEED              base seed, incremented per window (default: 1106558644923357)
  OUTPUT_PREFIX     SaveVideo filename_prefix (default: video/ComfyUI_FULLCHAIN)
  OUTPUT_JSON       where to write the built prompt (default: /tmp/api_workflow.json)
  WORKFLOW_PATH     path to the UI-format workflow template json
  NEUTRALIZE_CUTAWAYS         disable the scene-cut cleanup below by setting to "0" (default: "1")
  SCENE_CUT_THRESHOLD         ffmpeg scene-score delta that counts as a hard cut (default: 0.12)
  MAX_CUTAWAY_RUN_FRAMES      only auto-neutralize runs up to this long (default: 15)
  DYNAMIC_SAM2_POINT          disable the per-video SAM2 click-point below by setting to "0" (default: "1")
  AUTO_FPS                    disable driving-video fps auto-detect below by setting to "0" (default: "1")

Each "Video Extend" window contributes 77 frames on the first window and
~72 net new frames per additional window (77 minus the 5-frame continue_motion
overlap). N_EXTEND_WINDOWS is derived from DRIVING_FRAMES (0 when the first
window alone covers the clip). Remaining overshoot is trimmed + audio muxed
in the Node runner via ffmpeg against the driving file.

Driving-video edit cuts (a short B-roll/cutaway insert spliced into someone's
source clip) confuse this pipeline: WanAnimateToVideo is built to map ONE
reference character onto the driving motion, so when the driving footage
itself jump-cuts to unrelated framing for a couple of frames, DWPose's face
bbox collapses to match that unrelated framing and the face crop feeds garbage
into the model for those frames -- visible as a jarring flash of wrong content
in the output. This isn't a bbox-detector bug: the driving frames really are
a different shot. _neutralize_driving_cutaways() detects short scene-cut runs
via ffmpeg scene-score and hold-frames over them (before the video reaches
Comfy) so a driving clip with editing cuts doesn't corrupt the render. Only
touches the local copy of THIS job's driving file; never modifies the Talk
(build_infinitetalk_api.py) or I2V pipelines.

Sam2Segmentation (node 107) isolates the driving video's own person so it can
be masked out and replaced with the reference character. The template's
PointsEditor (node 229) hardcodes ONE static click-point (192, 332.8) in the
480x832 frame for this -- assuming every driving video frames its subject the
same way (centered, chest-height, normal seated/standing pose). When a driving
video frames the subject differently (closer/further away, lying down,
unusual pose), that fixed point lands on the wrong thing -- a body/background
edge, an unrelated limb, or nothing coherent at all -- Sam2Segmentation grabs
the wrong region, and the ORIGINAL driving-video person leaks through in the
output instead of being replaced. _compute_sam2_point() runs a small
standalone DWPose pass on the driving video's first frame and uses the
person's neck keypoint (stable regardless of arm/leg pose) as the click-point
instead, so segmentation targets the actual subject in every clip.

CreateVideo tags every window's output at a hardcoded 30fps regardless of the
driving video's real frame rate. DRIVING_FRAMES already maps 1 driving frame
to 1 output frame, so a clip shot at e.g. 24fps still gets all its frames --
but re-timed to 30fps, the render plays back ~25% faster than the driving
audio (muxed from the same file at its true pace). The final audio/video mux
trims to min(video, audio) duration (see the "frozen tail" fix in
runners.ts), so the now-shorter, sped-up video silently truncates the tail of
the audio -- the clip looks like it cuts off mid-sentence, when really it's
just running too fast for its own soundtrack. _detect_driving_fps() probes
the driving file's real fps and uses that instead of the hardcoded default.
"""
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request

WF_PATH = os.environ.get(
    "WORKFLOW_PATH",
    os.path.join(os.path.dirname(__file__), "templates", "Wan22_Animate.json"),
)
IMAGE_FILE = os.environ.get("IMAGE_FILE", "ref3_image.png")
DRIVING_FILE = os.environ.get("DRIVING_FILE", "ref3_driving.mp4")
DRIVING_FRAMES = int(os.environ.get("DRIVING_FRAMES", "362"))
FPS = int(os.environ.get("FPS", "30"))
SEED = int(os.environ.get("SEED", "1106558644923357"))
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "video/ComfyUI_FULLCHAIN")
OUTPUT_JSON = os.environ.get("OUTPUT_JSON", "/tmp/api_workflow.json")
WIDTH = int(os.environ.get("OUT_WIDTH", "480"))
HEIGHT = int(os.environ.get("OUT_HEIGHT", "832"))

FIRST_WINDOW_FRAMES = 77
CONTINUE_MOTION_OVERLAP = 5
NET_FRAMES_PER_EXTRA_WINDOW = FIRST_WINDOW_FRAMES - CONTINUE_MOTION_OVERLAP  # 72

# WAN length widgets prefer 4n+1 (77 = 4*19+1).
def _wan_length(frames: int) -> int:
    frames = max(5, int(frames))
    return 4 * ((frames - 1) // 4) + 1


if DRIVING_FRAMES <= FIRST_WINDOW_FRAMES:
    N_EXTEND_WINDOWS = 0
    WINDOW1_LENGTH = _wan_length(DRIVING_FRAMES)
    LAST_EXTEND_LENGTH = FIRST_WINDOW_FRAMES
else:
    # Cover at least DRIVING_FRAMES; last extend length sized to the remainder.
    remaining_after_first = DRIVING_FRAMES - FIRST_WINDOW_FRAMES
    N_EXTEND_WINDOWS = max(1, math.ceil(remaining_after_first / NET_FRAMES_PER_EXTRA_WINDOW))
    WINDOW1_LENGTH = FIRST_WINDOW_FRAMES
    covered_before_last = FIRST_WINDOW_FRAMES + (N_EXTEND_WINDOWS - 1) * NET_FRAMES_PER_EXTRA_WINDOW
    last_net = max(1, DRIVING_FRAMES - covered_before_last)
    LAST_EXTEND_LENGTH = _wan_length(last_net + CONTINUE_MOTION_OVERLAP)

wf = json.load(open(WF_PATH))
nodes = wf["nodes"]
links = {l[0]: l for l in wf["links"]}
subgraph_defs = {s["id"]: s for s in wf["definitions"]["subgraphs"]}

SG232_ID = "90db3fa1-b7fd-4c97-90a4-3e9533589dce"   # "Video Sampling and output" subgraph def (window 1)
SGEXT_ID = "975ed319-ca2b-461e-b42a-8e2704ba902f"   # "Video Extend" subgraph def (windows 2..N)

EXCLUDE = {242, 278, 277, 243, 19}  # original template's hardcoded 2nd/3rd extend instances + their save nodes (19, 243); we replace these with our own N-window chain saved by node "9999"
SUBGRAPH_INSTANCE_ID = 232

CONN_TYPES = ("IMAGE", "LATENT", "CONDITIONING", "VAE", "MODEL", "CLIP", "MASK", "CLIP_VISION_OUTPUT", "CLIP_VISION", "SAM2MODEL", "AUDIO", "VIDEO")

types_needed = set()
for n in nodes:
    if n["id"] in EXCLUDE:
        continue
    t = n["type"]
    if isinstance(t, str) and t not in subgraph_defs:
        types_needed.add(t)
sg232 = subgraph_defs[SG232_ID]
sgext = subgraph_defs[SGEXT_ID]
for n in sg232["nodes"]:
    types_needed.add(n["type"])
for n in sgext["nodes"]:
    types_needed.add(n["type"])
types_needed.add("SaveVideo")
types_needed.add("SDPoseFaceBBoxes")
types_needed.add("CropByBBoxes")

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_API_TOKEN = os.environ.get("COMFY_API_TOKEN", "").strip()

def _comfy_req(path: str, method: str = "GET", data: bytes = None, extra_headers: dict = None):
    req = urllib.request.Request(f"{COMFY_URL}{path}", data=data, method=method)
    req.add_header("User-Agent", os.environ.get("HTTP_UA", "xxmachine-my-pod/1.0"))
    if COMFY_API_TOKEN:
        req.add_header("Authorization", f"Bearer {COMFY_API_TOKEN}")
    for k, v in (extra_headers or {}).items():
        req.add_header(k, v)
    return req


NEUTRALIZE_CUTAWAYS = os.environ.get("NEUTRALIZE_CUTAWAYS", "1") != "0"
SCENE_CUT_THRESHOLD = float(os.environ.get("SCENE_CUT_THRESHOLD", "0.12"))
MAX_CUTAWAY_RUN_FRAMES = int(os.environ.get("MAX_CUTAWAY_RUN_FRAMES", "15"))


def _download_comfy_input(filename: str, dest_path: str) -> None:
    req = _comfy_req(f"/view?filename={urllib.parse.quote(filename)}&type=input")
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    with open(dest_path, "wb") as f:
        f.write(data)


def _upload_comfy_input(local_path: str, filename: str) -> str:
    boundary = "xxmachineboundary" + os.urandom(8).hex()
    with open(local_path, "rb") as f:
        file_bytes = f.read()

    def _field(name, value):
        return (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ).encode()

    body = b"".join([
        _field("type", "input"),
        _field("overwrite", "true"),
        (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{filename}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n"
        ).encode(),
        file_bytes,
        f"\r\n--{boundary}--\r\n".encode(),
    ])
    req = _comfy_req(
        "/upload/image",
        method="POST",
        data=body,
        extra_headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        resp = json.loads(r.read())
    return resp.get("name", filename)


def _probe_fps(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True, timeout=30, check=True,
    ).stdout.strip()
    num, _, den = out.partition("/")
    return float(num) / float(den or 1)


def _scene_scores(path: str) -> dict:
    """Per-frame ffmpeg scene-change score, keyed by 0-based frame index."""
    proc = subprocess.run(
        ["ffmpeg", "-i", path, "-vf", "select='gte(scene\\,0)',metadata=print", "-f", "null", "-"],
        capture_output=True, text=True, timeout=120,
    )
    scores, frame_idx = {}, None
    for line in proc.stderr.splitlines():
        m = re.search(r"frame:(\d+)\s+pts:", line)
        if m:
            frame_idx = int(m.group(1))
        m2 = re.search(r"scene_score=([\d.]+)", line)
        if m2 and frame_idx is not None:
            scores[frame_idx] = float(m2.group(1))
    return scores


def _neutralize_driving_cutaways(filename: str) -> str:
    """
    Detects short scene-cut runs (edit splices / B-roll cutaways) baked into the
    driving video and hold-frames over them, so a single reference character
    doesn't get crossed with an unrelated shot for a few frames. Returns the
    (possibly new) Comfy input filename to use as DRIVING_FILE. Never raises —
    any failure just falls back to the original file untouched.
    """
    if not NEUTRALIZE_CUTAWAYS:
        return filename
    workdir = tempfile.mkdtemp(prefix="xxm_driving_clean_")
    try:
        src = os.path.join(workdir, "src.mp4")
        _download_comfy_input(filename, src)

        scores = _scene_scores(src)
        boundaries = sorted(i for i, s in scores.items() if s >= SCENE_CUT_THRESHOLD and i > 0)
        bad_ranges = []
        i = 0
        while i < len(boundaries) - 1:
            start, end = boundaries[i], boundaries[i + 1]
            if 0 < end - start <= MAX_CUTAWAY_RUN_FRAMES:
                bad_ranges.append((start, end))
                i += 2
            else:
                i += 1
        if not bad_ranges:
            return filename

        bad_frames = set()
        for start, end in bad_ranges:
            bad_frames.update(range(start, end))
        print(
            f"Detected {len(bad_frames)} likely edit-cut/cutaway frame(s) in driving video "
            f"{filename}: {sorted(bad_frames)} — hold-framing over them before Animate."
        )

        frames_pattern = os.path.join(workdir, "f_%06d.png")
        subprocess.run(
            ["ffmpeg", "-y", "-i", src, "-vsync", "0", frames_pattern],
            capture_output=True, timeout=180, check=True,
        )
        total_frames = max(scores.keys()) + 1 if scores else 0
        last_good = None
        for idx in range(total_frames):
            fp = os.path.join(workdir, f"f_{idx + 1:06d}.png")
            if idx in bad_frames:
                if last_good is not None:
                    good_fp = os.path.join(workdir, f"f_{last_good + 1:06d}.png")
                    if os.path.exists(good_fp):
                        shutil.copyfile(good_fp, fp)
            else:
                last_good = idx

        fps = _probe_fps(src)
        video_only = os.path.join(workdir, "video_only.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-r", str(fps), "-i", frames_pattern,
             "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", video_only],
            capture_output=True, timeout=180, check=True,
        )
        cleaned = os.path.join(workdir, "cleaned.mp4")
        subprocess.run(
            ["ffmpeg", "-y", "-i", video_only, "-i", src,
             "-map", "0:v:0", "-map", "1:a:0?",
             "-c:v", "copy", "-c:a", "copy", "-shortest", cleaned],
            capture_output=True, timeout=180, check=True,
        )
        clean_name = f"clean_{filename}"
        return _upload_comfy_input(cleaned, clean_name)
    except Exception as e:
        print(f"WARN: driving cutaway cleanup skipped: {e}")
        return filename
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


DRIVING_FILE = _neutralize_driving_cutaways(DRIVING_FILE)

DYNAMIC_SAM2_POINT = os.environ.get("DYNAMIC_SAM2_POINT", "1") != "0"
SAM2_POINT_DEFAULT = (192, 332.8)  # template's original static point, used as fallback


def _submit_and_wait(prompt: dict, timeout: int = 90) -> dict:
    payload = json.dumps({"prompt": prompt}).encode()
    req = _comfy_req("/prompt", method="POST", data=payload,
                      extra_headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        resp = json.loads(r.read())
    if resp.get("node_errors"):
        raise RuntimeError(f"preflight submit rejected: {json.dumps(resp['node_errors'])[:500]}")
    prompt_id = resp["prompt_id"]
    deadline = time.time() + timeout
    while time.time() < deadline:
        with urllib.request.urlopen(_comfy_req(f"/history/{prompt_id}"), timeout=30) as r:
            hist = json.loads(r.read())
        entry = hist.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "success":
                return entry.get("outputs", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"preflight job failed: {json.dumps(status)[:500]}")
        time.sleep(2)
    raise TimeoutError("preflight DWPose point-detection job timed out")


def _compute_sam2_point(filename: str):
    """
    Runs a standalone DWPose pass on the driving video's first frame and
    returns (x, y) of the person's neck keypoint in WIDTH x HEIGHT space, for
    use as the Sam2Segmentation click-point (see module docstring). Falls
    back to SAM2_POINT_DEFAULT on any failure — never blocks the main render.
    """
    if not DYNAMIC_SAM2_POINT:
        return SAM2_POINT_DEFAULT
    try:
        preflight = {
            "1": {"class_type": "LoadVideo", "inputs": {"file": filename}},
            "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
            "3": {"class_type": "ImageFromBatch", "inputs": {"image": ["2", 0], "batch_index": 0, "length": 1}},
            "4": {"class_type": "ImageScale", "inputs": {
                "image": ["3", 0], "width": WIDTH, "height": HEIGHT,
                "upscale_method": "lanczos", "crop": "center",
            }},
            "5": {"class_type": "DWPreprocessor", "inputs": {
                "image": ["4", 0], "resolution": 512,
                "detect_hand": "disable", "detect_body": "enable", "detect_face": "disable",
                "bbox_detector": "yolox_l.onnx", "pose_estimator": "dw-ll_ucoco_384.onnx",
                "scale_stick_for_xinsr_cn": "disable",
            }},
            # Comfy rejects a prompt with no OUTPUT_NODE at all ("prompt_no_outputs", HTTP 400)
            # before it ever queues -- DWPreprocessor itself isn't one, so this dummy sink is
            # required for the submission to be accepted. Its image is never read.
            "6": {"class_type": "PreviewImage", "inputs": {"images": ["5", 0]}},
        }
        outputs = _submit_and_wait(preflight, timeout=120)
        raw = outputs["5"]["openpose_json"][0]
        frame0 = json.loads(raw)[0]
        kp = frame0["people"][0]["pose_keypoints_2d"]

        def _pt(idx):
            x, y, conf = kp[idx * 3], kp[idx * 3 + 1], kp[idx * 3 + 2]
            return (x, y) if conf > 0.1 else None

        point = _pt(1) or _pt(0)  # OpenPose index 1 = neck (stable across arm/leg pose), else nose
        if point is None:
            print(f"WARN: no confident neck/nose keypoint for {filename}, using template default")
            return SAM2_POINT_DEFAULT
        x = min(max(point[0], 20), WIDTH - 20)
        y = min(max(point[1], 20), HEIGHT - 20)
        print(f"Dynamic SAM2 point for {filename}: ({x:.1f}, {y:.1f}) (template default was {SAM2_POINT_DEFAULT})")
        return (x, y)
    except Exception as e:
        print(f"WARN: dynamic SAM2 point detection failed for {filename}, using template default: {e}")
        return SAM2_POINT_DEFAULT


SAM2_POINT_X, SAM2_POINT_Y = _compute_sam2_point(DRIVING_FILE)

AUTO_FPS = os.environ.get("AUTO_FPS", "1") != "0"


def _detect_driving_fps(filename: str) -> float:
    """Probes the driving file's real fps; falls back to FPS on any failure."""
    if not AUTO_FPS:
        return FPS
    workdir = tempfile.mkdtemp(prefix="xxm_fps_probe_")
    try:
        src = os.path.join(workdir, "src.mp4")
        _download_comfy_input(filename, src)
        fps = _probe_fps(src)
        if fps and fps > 0:
            print(f"Detected driving fps={fps:.3f} for {filename} (default was {FPS})")
            return fps
        return FPS
    except Exception as e:
        print(f"WARN: driving fps detection failed for {filename}, using default {FPS}: {e}")
        return FPS
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


FPS = _detect_driving_fps(DRIVING_FILE)

obj_info = {}
for t in types_needed:
    try:
        with urllib.request.urlopen(_comfy_req(f"/object_info/{t}"), timeout=30) as r:
            data = json.loads(r.read())
            if t in data:
                obj_info[t] = data[t]
    except Exception as e:
        print(f"WARN: {t}: {e}")

# Hard-required for a valid WAN Animate API graph.
# Silent skip of missing types leaves dangling refs (e.g. Sam2Segmentation id 107,
# DWPreprocessor 100/101) — fail early instead.
_REQUIRED_FOR_ANIMATE = ("DWPreprocessor", "Sam2Segmentation", "WanAnimateToVideo", "SaveVideo")
_missing_req = [t for t in _REQUIRED_FOR_ANIMATE if t not in obj_info]
if _missing_req:
    raise SystemExit(
        "Missing Comfy node types on pod (install/auto-ensure failed): "
        + ", ".join(_missing_req)
        + ". Need comfyui_controlnet_aux (DWPreprocessor), "
        "ComfyUI-segment-anything-2 (Sam2Segmentation), and WAN Animate nodes."
    )


def widget_capable_order(ntype):
    info = obj_info[ntype]
    input_order = list(info["input"].get("required", {}).keys()) + list(info["input"].get("optional", {}).keys())
    input_spec = {**info["input"].get("required", {}), **info["input"].get("optional", {})}
    return [name for name in input_order if input_spec.get(name, [None])[0] not in CONN_TYPES]


def fill_widgets(node_inputs, ntype, linked_names, wv):
    # UI widgets_values reserves a slot per widget-capable input IN SCHEMA ORDER, even for
    # UI-only widgets (like KSampler's control_after_generate) that have no real API input.
    # Must advance the index for every slot, only assigning to names not already linked.
    if not isinstance(wv, list):
        return
    order = widget_capable_order(ntype)
    wi = 0
    for name in order:
        if wi >= len(wv):
            break
        val = wv[wi]
        wi += 1
        if name not in linked_names:
            node_inputs[name] = val


api = {}

# ---- regular top-level nodes ----
for n in nodes:
    if n["id"] in EXCLUDE or n["id"] == SUBGRAPH_INSTANCE_ID:
        continue
    ntype = n["type"]
    if not isinstance(ntype, str) or ntype not in obj_info:
        continue
    node_inputs = {}
    linked_names = set()
    for inp in n.get("inputs", []) or []:
        name = inp.get("name")
        link_id = inp.get("link")
        if link_id is not None and link_id in links:
            l = links[link_id]
            node_inputs[name] = [str(l[1]), l[2]]
            linked_names.add(name)
    fill_widgets(node_inputs, ntype, linked_names, n.get("widgets_values"))
    api[str(n["id"])] = {"class_type": ntype, "inputs": node_inputs}

# ---- face crop: derive per-frame face bbox from DWPose keypoints (node 100), crop real RGB
# pixels for face_video instead of feeding a tiny skeleton render (WanAnimateToVideo normalizes
# face_video as raw pixels *2-1, so it expects photographic content, not sparse keypoint dots) ----
api["facebbox"] = {"class_type": "SDPoseFaceBBoxes", "inputs": {"keypoints": ["100", 1], "scale": 1.6, "force_square": True}}
api["facecrop"] = {"class_type": "CropByBBoxes", "inputs": {"image": ["212", 0], "bboxes": ["facebbox", 0], "output_width": 512, "output_height": 512, "padding": 0}}

# ---- expand sg232 (window 1: "Video Sampling and output") ----
def prefixed232(i):
    return f"sg232_{i}"


sg232_links = sg232["links"]
ext_source_for_slot_232 = {}
for l in wf["links"]:
    if l[3] == SUBGRAPH_INSTANCE_ID:
        ext_source_for_slot_232[l[4]] = (str(l[1]), l[2])
ext_source_for_slot_232[7] = ("facecrop", 0)  # face_video: real cropped RGB pixels, not skeleton

for n in sg232["nodes"]:
    ntype = n["type"]
    node_inputs = {}
    linked_names = set()
    for inp in n.get("inputs", []) or []:
        name = inp.get("name")
        link_id = inp.get("link")
        if link_id is None:
            continue
        l = next((x for x in sg232_links if x["id"] == link_id), None)
        if l is None:
            continue
        if l["origin_id"] == -10:
            slot = l["origin_slot"]
            if slot in ext_source_for_slot_232:
                node_inputs[name] = list(ext_source_for_slot_232[slot])
                linked_names.add(name)
        else:
            node_inputs[name] = [prefixed232(l["origin_id"]), l["origin_slot"]]
            linked_names.add(name)
    fill_widgets(node_inputs, ntype, linked_names, n.get("widgets_values"))
    api[prefixed232(n["id"])] = {"class_type": ntype, "inputs": node_inputs}

# rewire any top-level node pointing at 232's outputs -> real expanded nodes
sg232_output_source = {}
for l in sg232_links:
    if l["target_id"] == -20:
        sg232_output_source[l["target_slot"]] = (prefixed232(l["origin_id"]), l["origin_slot"])

for target_id_str, node in api.items():
    if target_id_str.startswith("sg232_"):
        continue
    for name, val in list(node["inputs"].items()):
        if isinstance(val, list) and len(val) == 2 and val[0] == str(SUBGRAPH_INSTANCE_ID):
            slot = val[1]
            if slot in sg232_output_source:
                node["inputs"][name] = list(sg232_output_source[slot])

# ---- per-job overrides (window 1 / shared) ----
api["10"]["inputs"]["image"] = IMAGE_FILE
api["145"]["inputs"]["file"] = DRIVING_FILE
api["159"]["inputs"]["value"] = WIDTH
api["160"]["inputs"]["value"] = HEIGHT
api[prefixed232(62)]["inputs"]["length"] = WINDOW1_LENGTH
api[prefixed232(62)]["inputs"]["batch_size"] = 1
api[prefixed232(63)]["inputs"]["seed"] = SEED
api[prefixed232(63)]["inputs"]["steps"] = 6
api[prefixed232(63)]["inputs"]["cfg"] = 1.0
api[prefixed232(63)]["inputs"]["sampler_name"] = "euler"
api[prefixed232(63)]["inputs"]["scheduler"] = "simple"
api[prefixed232(63)]["inputs"]["denoise"] = 1.0
api[prefixed232(15)]["inputs"]["fps"] = FPS
# Driving audio from GetVideoComponents (node 23) — must reach final CreateVideo.
api[prefixed232(15)]["inputs"]["audio"] = ["23", 1]
for dwid in ("100", "101"):
    if dwid in api:
        api[dwid]["inputs"]["pose_estimator"] = "dw-ll_ucoco_384.onnx"
if "229" in api:
    api["229"]["inputs"]["points_store"] = json.dumps({
        "positive": [{"x": SAM2_POINT_X, "y": SAM2_POINT_Y}],
        "negative": [{"x": 0, "y": 0}],
    })
    api["229"]["inputs"]["coordinates"] = json.dumps([{"x": SAM2_POINT_X, "y": SAM2_POINT_Y}])

# Default final VIDEO = window-1 CreateVideo (used when N_EXTEND_WINDOWS == 0).
vid_src = (prefixed232(15), 0)

# ---- generic Video Extend window expansion (reused N times) ----
if N_EXTEND_WINDOWS > 0:
    sgext_links = sgext["links"]

    # constant external sources for the extend subgraph's boundary inputs (slots 0-19),
    # derived from the top-level links that fed the original node 242 instance.
    const_source_for_slot = {}
    for l in wf["links"]:
        if l[3] == 242 and l[4] not in (3, 13):  # exclude image1(3) and video_frame_offset(13) - dynamic
            const_source_for_slot[l[4]] = (str(l[1]), l[2])
    const_source_for_slot[8] = ("facecrop", 0)  # face_video: real cropped RGB pixels, not skeleton

    createvideo_id = next(n["id"] for n in sgext["nodes"] if n["type"] == "CreateVideo")
    imagebatch_id = next(n["id"] for n in sgext["nodes"] if n["type"] == "ImageBatch")
    wanA_id = next(n["id"] for n in sgext["nodes"] if n["type"] == "WanAnimateToVideo")
    ksampler_id = next(n["id"] for n in sgext["nodes"] if n["type"] == "KSampler")

    def expand_extend_window(prefix, image1_source, offset_source, window_widgets):
        """window_widgets: dict node_id(int) -> widgets_values list, override per-window."""
        for n in sgext["nodes"]:
            ntype = n["type"]
            node_inputs = {}
            linked_names = set()
            for inp in n.get("inputs", []) or []:
                name = inp.get("name")
                link_id = inp.get("link")
                if link_id is None:
                    continue
                l = next((x for x in sgext_links if x["id"] == link_id), None)
                if l is None:
                    continue
                if l["origin_id"] == -10:
                    slot = l["origin_slot"]
                    if slot == 3:
                        node_inputs[name] = list(image1_source)
                        linked_names.add(name)
                    elif slot == 13:
                        node_inputs[name] = list(offset_source)
                        linked_names.add(name)
                    elif slot in const_source_for_slot:
                        node_inputs[name] = list(const_source_for_slot[slot])
                        linked_names.add(name)
                else:
                    node_inputs[name] = [f"{prefix}{l['origin_id']}", l["origin_slot"]]
                    linked_names.add(name)
            wv = window_widgets.get(n["id"], n.get("widgets_values"))
            fill_widgets(node_inputs, ntype, linked_names, wv)
            api[f"{prefix}{n['id']}"] = {"class_type": ntype, "inputs": node_inputs}
        return (f"{prefix}{imagebatch_id}", 0), (f"{prefix}{wanA_id}", 5), (f"{prefix}{createvideo_id}", 0)

    wan_widgets = next(n.get("widgets_values") for n in sgext["nodes"] if n["id"] == wanA_id)
    createvideo_widgets = next(n.get("widgets_values") for n in sgext["nodes"] if n["id"] == createvideo_id)

    img_src = (prefixed232(58), 0)
    off_src = (prefixed232(62), 5)

    for k in range(1, N_EXTEND_WINDOWS + 1):
        prefix = f"sgext{k}_"
        window_widgets = {
            wanA_id: wan_widgets,
            createvideo_id: createvideo_widgets,
        }
        img_src, off_src, vid_src = expand_extend_window(prefix, img_src, off_src, window_widgets)
        api[f"{prefix}{ksampler_id}"]["inputs"]["seed"] = SEED + k
        api[f"{prefix}{ksampler_id}"]["inputs"]["steps"] = 6
        api[f"{prefix}{ksampler_id}"]["inputs"]["cfg"] = 1.0
        api[f"{prefix}{ksampler_id}"]["inputs"]["sampler_name"] = "euler"
        api[f"{prefix}{ksampler_id}"]["inputs"]["scheduler"] = "simple"
        api[f"{prefix}{ksampler_id}"]["inputs"]["denoise"] = 1.0
        api[f"{prefix}{wanA_id}"]["inputs"]["height"] = ["160", 0]
        # Last window shorter so we don't invent a frozen tail beyond the driving clip.
        length = LAST_EXTEND_LENGTH if k == N_EXTEND_WINDOWS else FIRST_WINDOW_FRAMES
        api[f"{prefix}{wanA_id}"]["inputs"]["length"] = length
        api[f"{prefix}{createvideo_id}"]["inputs"]["fps"] = FPS
        # Previous bug: audio only on window-1 CreateVideo, but SaveVideo always
        # consumed the LAST extend CreateVideo → silent outputs.
        api[f"{prefix}{createvideo_id}"]["inputs"]["audio"] = ["23", 1]

# ---- final SaveVideo consuming the LAST window's VIDEO output ----
api["9999"] = {
    "class_type": "SaveVideo",
    "inputs": {
        "video": [vid_src[0], vid_src[1]],
        "filename_prefix": OUTPUT_PREFIX,
        "format": "auto",
        "codec": "auto",
    },
}

# Validate every linked node id exists before Comfy sees the prompt (catches KeyError '101').
_missing_refs = set()
for _nid, _node in api.items():
    for _val in (_node.get("inputs") or {}).values():
        if isinstance(_val, list) and len(_val) >= 1 and isinstance(_val[0], str):
            if _val[0] not in api:
                _missing_refs.add(_val[0])
if _missing_refs:
    raise SystemExit(
        "Built graph references missing node ids: "
        + ", ".join(sorted(_missing_refs)[:20])
        + ". A required node type was skipped (not on pod /object_info) — "
        "common: DWPreprocessor 100/101, Sam2Segmentation 107."
    )

json.dump(api, open(OUTPUT_JSON, "w"), indent=2)
print(
    f"Built API workflow with {len(api)} nodes, {N_EXTEND_WINDOWS} extend windows, "
    f"window1_length={WINDOW1_LENGTH}, last_extend_length={LAST_EXTEND_LENGTH}, "
    f"driving_frames={DRIVING_FRAMES}, image={IMAGE_FILE}, driving={DRIVING_FILE}, "
    f"sam2_point=({SAM2_POINT_X:.1f},{SAM2_POINT_Y:.1f}), fps={FPS:.3f}"
)
