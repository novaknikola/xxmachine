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

Each "Video Extend" window contributes 77 frames on the first window and
~72 net new frames per additional window (77 minus the 5-frame continue_motion
overlap). N_EXTEND_WINDOWS is derived from DRIVING_FRAMES so the chain always
covers the full driving video (may overshoot by a few frames - harmless).
"""
import json
import math
import os
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
N_EXTEND_WINDOWS = max(1, math.ceil((DRIVING_FRAMES - FIRST_WINDOW_FRAMES) / NET_FRAMES_PER_EXTRA_WINDOW))

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

def _comfy_req(path: str):
    req = urllib.request.Request(f"{COMFY_URL}{path}")
    req.add_header("User-Agent", os.environ.get("HTTP_UA", "xxmachine-my-pod/1.0"))
    if COMFY_API_TOKEN:
        req.add_header("Authorization", f"Bearer {COMFY_API_TOKEN}")
    return req

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
api[prefixed232(62)]["inputs"]["length"] = FIRST_WINDOW_FRAMES
api[prefixed232(62)]["inputs"]["batch_size"] = 1
api[prefixed232(63)]["inputs"]["seed"] = SEED
api[prefixed232(63)]["inputs"]["steps"] = 6
api[prefixed232(63)]["inputs"]["cfg"] = 1.0
api[prefixed232(63)]["inputs"]["sampler_name"] = "euler"
api[prefixed232(63)]["inputs"]["scheduler"] = "simple"
api[prefixed232(63)]["inputs"]["denoise"] = 1.0
api[prefixed232(15)]["inputs"]["fps"] = FPS
api[prefixed232(15)]["inputs"]["audio"] = ["23", 1]
for dwid in ("100", "101"):
    if dwid in api:
        api[dwid]["inputs"]["pose_estimator"] = "dw-ll_ucoco_384.onnx"

# ---- generic Video Extend window expansion (reused N times) ----
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
    """window_widgets: dict node_id(int) -> widgets_values list, override per-window (seed/steps/cfg/etc + length)"""
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
vid_src = None

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
    api[f"{prefix}{wanA_id}"]["inputs"]["height"] = ["160", 0]  # extend subgraph only exposes one "width" boundary input that's wired to BOTH width+height internally; force real height here
    api[f"{prefix}{createvideo_id}"]["inputs"]["fps"] = FPS

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
print(f"Built API workflow with {len(api)} nodes, {N_EXTEND_WINDOWS} extend windows chained, image={IMAGE_FILE}, driving={DRIVING_FILE}")
