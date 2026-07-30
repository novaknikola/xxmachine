"""
Builds an API-format ComfyUI prompt for InfiniteTalk (ComfyUI-WanVideoWrapper,
https://github.com/kijai/ComfyUI-WanVideoWrapper), a whole-head/body
audio-driven talking-avatar model built on Wan2.1 14B -- tried 2026-07-23
after both LatentSync (face-crop-paste-back, user's verdict: "too AI, just a
picture with moving mouth") and LTX-2.3 LipDub IC-LoRA (three independent
fix attempts, zero lip movement in all of them) failed to produce a
convincing result. InfiniteTalk is MeiGen-AI's successor to MultiTalk,
explicitly marketed as fixing MultiTalk's distortion/stability issues, and
unlike LatentSync it regenerates the whole frame (natural head/body motion),
not just a pasted-back mouth region.

Base template is UI-format (nodes/links, no subgraphs) from
`kijai/ComfyUI-WanVideoWrapper`'s own example workflow
(`example_workflows/wanvideo_2_1_14B_I2V_InfiniteTalk_example_03.json`,
copied into this repo as `wanvideo_infinitetalk_template.json`).

IMPORTANT lesson from the first attempt at this build script (2026-07-23):
the naive approach of copying the template's own `widgets_values` positionally
(same technique that worked fine for the LTX scripts) FAILED HARD here --
this pod's installed ComfyUI-WanVideoWrapper version has added many new
required widget fields since the example workflow was authored (force_offload,
strength_1/2, use_disk_cache, riflex_freq_index, frame_window_size,
motion_frame, audio_cfg_scale, and more), which shifts every later widget in
the array into the wrong field across ~10 different node types simultaneously
(e.g. the negative-prompt string landing in a `device` enum field). This is a
actively-developed wrapper repo, unlike LTX's more stable template, so
positional widget-filling is NOT safe to trust here.

Fix: don't copy widgets_values at all. For every required, non-connected
widget field, use that field's own CURRENT declared default value straight
from /object_info (fetched fresh every build, so this survives future
wrapper updates too), then apply only the specific overrides that actually
matter by NAME afterward. Verified every one of those override key names
against a full /object_info dump before writing them (this project's
repeatedly-learned lesson: never guess a ComfyUI input key name).

This template also uses rgthree's SetNode/GetNode pairs as visual variable
pass-throughs (not Reroute) -- resolved the same way as the Reroute-chasing
logic in build_ltx_i2v_api.py (follow Get -> matching Set -> Set's own
upstream link, recursively), so rgthree-comfy doesn't need to be installed;
the flattened graph never references Set/Get.

The vocal-isolation step in the original template (MelBandRoFormerModelLoader
+ MelBandRoFormerSampler, node 301/302, strips background music before
wav2vec feature extraction) is SKIPPED here -- our audio is already clean
single-voice Fish Audio TTS output with no background music to remove, and
it's one more custom-node package + model file this project doesn't already
have. The input audio is wired directly into MultiTalkWav2VecEmbeds's
audio_1 input instead (that input's type is plain AUDIO, matching a raw
LoadAudio output).

The actual resize target for the source image is NOT
WanVideoImageToVideoMultiTalk's own width/height widgets (those are
overridden by a link from GetImageSizeAndCount, which measures the image
*after* it's already been resized -- i.e. downstream, not upstream) -- it's
two INTConstant nodes (245/246) feeding ImageResizeKJv2 via SetNode/GetNode
"width"/"height" pass-throughs. Traced by hand via the links array since this
indirection isn't obvious from the node graph alone.

Env vars:
  INPUT_IMAGE     filename already present in ComfyUI/input/ (the portrait)
  INPUT_AUDIO     filename already present in ComfyUI/input/ (target TTS voice)
  PROMPT_TEXT     scene description for the underlying Wan2.1 I2V model --
                  NOT literal dialogue (unlike LTX LipDub's prompt, which had
                  to contain the spoken words; InfiniteTalk's speech content
                  comes entirely from the audio's wav2vec features, the text
                  prompt here is just an ordinary I2V scene guide)
  NEGATIVE_PROMPT_TEXT   optional override, has the template's default
  WIDTH/HEIGHT    resize target for the source image (default 480x832,
                  portrait -- must be divisible by the resize node's
                  divisible_by setting, 16 here)
  STEPS/CFG/SHIFT seed sampler settings -- default to a fast-distill-friendly
                  6/1.0/5.0 since the Lightx2v step-distill LoRA is loaded
                  (running a distilled LoRA at the node's own generic
                  defaults, steps=30/cfg=6.0, would very likely be slow
                  and/or produce broken output -- same class of mistake as
                  the LTX distilled-vs-full-CFG lesson from earlier this
                  project)
  SEED            sampler seed, random if unset
  OUTPUT_PREFIX   VHS_VideoCombine filename_prefix (default: video/infinitetalk)
  OUTPUT_JSON     where to write the built prompt
  WORKFLOW_PATH   path to the UI-format template json
"""
import json
import os
import random
import urllib.request

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
WF_PATH = os.environ.get(
    "WORKFLOW_PATH",
    os.path.join(os.path.dirname(__file__), "wanvideo_infinitetalk_template.json"),
)
OUTPUT_JSON = os.environ.get("OUTPUT_JSON", "/tmp/infinitetalk_api_workflow.json")

INPUT_IMAGE = os.environ.get("INPUT_IMAGE", "woman.png")
INPUT_AUDIO = os.environ.get("INPUT_AUDIO", "hush.mp3")
# Confirmed 2026-07-23 via a real A/B test (see run_infinitetalk_ab_test.py /
# LTX_PIPELINE_NOTES.md) that a motion-descriptive prompt beats a generic
# placeholder, and that CFG=1.0/distilled-LoRA (the fast default below) gives
# just as good motion control as full CFG=5/25-steps/no-LoRA for this use
# case -- user's verdict was "odlican" (excellent) on the fast variant, no
# improvement from the ~4x-slower full variant. Use this as the baseline
# prompt rather than reverting to something generic.
PROMPT_TEXT = os.environ.get(
    "PROMPT_TEXT",
    "a woman talking naturally to the camera, subtle natural head movements, "
    "calm relaxed hand gestures, steady camera, static plain background, "
    "realistic human motion",
)
NEGATIVE_PROMPT_TEXT = os.environ.get("NEGATIVE_PROMPT_TEXT", "")
WIDTH = int(os.environ.get("WIDTH", "480"))
HEIGHT = int(os.environ.get("HEIGHT", "832"))
STEPS = int(os.environ.get("STEPS", "6"))
CFG = float(os.environ.get("CFG", "1.0"))
SHIFT = float(os.environ.get("SHIFT", "5.0"))
SEED = os.environ.get("SEED")
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "video/infinitetalk")
LIGHTX2V_LORA_NAME = os.environ.get(
    "LIGHTX2V_LORA_NAME", "lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"
)
TEXT_ENCODER_MODEL_NAME = os.environ.get("TEXT_ENCODER_MODEL_NAME", "umt5-xxl-enc-bf16.safetensors")

# Whether to load the lightx2v step-distill LoRA at all. Off (USE_DISTILLED_LORA=0)
# is the "full model" A/B variant requested 2026-07-23 to test whether prompt
# text has stronger influence over body/head motion at a normal (non-distilled)
# CFG -- distillation is a speed/fidelity trade that can mute fine-grained
# conditioning response (same class of issue diagnosed for LTX's distilled
# LipDub variant earlier in this project), and at CFG=1.0 (required for the
# distilled LoRA) classifier-free guidance is mathematically a no-op, so the
# negative prompt does nothing and the positive prompt's pull is weaker too.
USE_DISTILLED_LORA = os.environ.get("USE_DISTILLED_LORA", "1") == "1"

DEFAULT_NEGATIVE = ("bright tones, overexposed, static, blurred details, subtitles, style, works, "
                    "paintings, images, static, overall gray, worst quality, low quality, JPEG "
                    "compression residue, ugly, incomplete, extra fingers, poorly drawn hands, "
                    "poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, "
                    "still picture, messy background, three legs, many people in the background, "
                    "walking backwards")

LOAD_IMAGE_NODE = 284
LOAD_AUDIO_NODE = 125
TEXT_ENCODE_NODE = 241
SAMPLER_NODE = 128
SAVE_VIDEO_NODE = 131
MULTITALK_EMBEDS_NODE = 194
MELBAND_LOADER_NODE = 301
MELBAND_SAMPLER_NODE = 302
MULTITALK_MODEL_NODE = 120
WANVIDEO_MODEL_NODE = 122
WANVIDEO_VAE_NODE = 129
LORA_SELECT_NODE = 138
IMAGE_TO_VIDEO_NODE = 192
RESIZE_NODE = 281
# The actual resize target the whole graph uses -- see module docstring.
RESIZE_WIDTH_NODE = 245
RESIZE_HEIGHT_NODE = 246
# "Max frames" constant feeding MultiTalkWav2VecEmbeds.num_frames via
# Set/Get indirection (title "Max frames" in the template, node 270) --
# left at the object_info default of 0 this crashes wav2vec's loudness-norm
# step with "Audio must have length greater than the block size" (confirmed
# 2026-07-23, first real submission attempt). Template's own authored value
# was 500; matching that here rather than tying it to actual audio duration
# since InfiniteTalk processes long audio in sliding windows internally.
MAX_FRAMES_NODE = 270
MAX_FRAMES = int(os.environ.get("MAX_FRAMES", "500"))

# These three loader nodes' model-file combo fields have no safe schema
# default (default_fill picks whatever happens to be first in this pod's
# alphabetically-sorted list, which is an unrelated LTX file, not a WanVideo
# one) -- must always be pinned explicitly. Confirmed exact current
# filenames/case/path-separators against this pod's live /object_info combo
# lists 2026-07-23 (the template JSON itself uses Windows "\\" separators,
# which don't match this pod's Linux paths).
MULTITALK_MODEL_NAME = os.environ.get(
    "MULTITALK_MODEL_NAME", "WanVideo/InfiniteTalk/Wan2_1-InfiniteTalk_Single_Q8.gguf"
)
WANVIDEO_MODEL_NAME = os.environ.get(
    "WANVIDEO_MODEL_NAME", "WanVideo/wan2.1-i2v-14b-480p-Q8_0.gguf"
)
WANVIDEO_VAE_NAME = os.environ.get(
    "WANVIDEO_VAE_NAME", "wanvideo/Wan2_1_VAE_bf16.safetensors"
)

wf = json.load(open(WF_PATH))
nodes = wf["nodes"]
top_links = {l[0]: l for l in wf["links"]}
node_by_id = {n["id"]: n for n in nodes}
node_type_by_id = {n["id"]: n["type"] for n in nodes}

EXCLUDE_TYPES = {"MarkdownNote", "Note", "PreviewAny"}
EXCLUDE_TOP = {n["id"] for n in nodes if n["type"] in EXCLUDE_TYPES}
# Skip the vocal-isolation pass entirely (see module docstring) -- its
# consumer (MultiTalkWav2VecEmbeds.audio_1) gets rewired straight to LoadAudio
# after flattening, below.
EXCLUDE_TOP.add(MELBAND_LOADER_NODE)
EXCLUDE_TOP.add(MELBAND_SAMPLER_NODE)
if not USE_DISTILLED_LORA:
    EXCLUDE_TOP.add(LORA_SELECT_NODE)

set_node_by_key = {}
for n in nodes:
    if n["type"] == "SetNode":
        set_node_by_key[n["widgets_values"][0]] = n["id"]

CONN_TYPES = {
    "IMAGE", "MASK", "LATENT", "CONDITIONING", "VAE", "MODEL", "CLIP", "AUDIO", "VIDEO",
    "NOISE", "SIGMAS", "GUIDER", "SAMPLER", "WANVIDEOMODEL", "WANVAE", "CLIP_VISION",
    "CLIP_VISION_OUTPUT", "WANVIDIMAGE_EMBEDS", "WANVIDIMAGE_CLIPEMBEDS", "WANVIDEOTEXTEMBEDS",
    "WAV2VECMODEL", "MULTITALKMODEL", "MULTITALK_EMBEDS", "WANVIDLORA", "FETAARGS",
    "WANVIDCONTEXT", "CACHEARGS", "FLOWEDITARGS", "SLGARGS", "LOOPARGS", "EXPERIMENTALARGS",
    "UNIANIMATE_POSE", "FANTASYTALKING_EMBEDS", "UNI3C_EMBEDS", "FREEINITARGS",
    "SELECTEDBLOCKS", "WANVIDEOPROMPTEXTENDER_ARGS", "VHS_BatchManager", "UNIQUE_ID",
    "PROMPT", "EXTRA_PNGINFO",
}

types_needed = {n["type"] for n in nodes if n["id"] not in EXCLUDE_TOP} - {"SetNode", "GetNode"}
obj_info = {}
# The User-Agent matters: when COMFY_URL points at a RunPod proxy rather than
# 127.0.0.1, Cloudflare answers Python's default "Python-urllib/3.x" with 403.
# That would be silent here -- the except below only warns -- so every node type
# would drop out and the workflow would be assembled against an empty schema.
UA = os.environ.get("HTTP_UA", "xxmachine-my-pod/1.0")
COMFY_API_TOKEN = os.environ.get("COMFY_API_TOKEN", "").strip()
for t in types_needed:
    try:
        headers = {"User-Agent": UA}
        if COMFY_API_TOKEN:
            headers["Authorization"] = f"Bearer {COMFY_API_TOKEN}"
        req = urllib.request.Request(f"{COMFY_URL}/object_info/{t}", headers=headers)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
            if t in data:
                obj_info[t] = data[t]
    except Exception as e:
        print(f"WARN: {t}: {e}")

# A total miss means we are not really talking to ComfyUI (wrong URL, 403, dead
# service). Building a workflow from an empty schema produces a subtly wrong API
# JSON that fails much later and much less clearly, so stop here instead.
if types_needed and not obj_info:
    raise SystemExit(
        f"ERROR: /object_info returned nothing for any of the {len(types_needed)} node types at "
        f"{COMFY_URL}. Check the URL is reachable and, if it is a proxy, that the request is not "
        f"being rejected (403) -- refusing to build a workflow against an empty schema.")

# Node 194 = MultiTalkWav2VecEmbeds — silent skip used to KeyError at audio_1 rewire.
_REQUIRED_TYPES = (
    "MultiTalkWav2VecEmbeds",
    "WanVideoImageToVideoMultiTalk",
    "LoadAudio",
    "LoadImage",
    "VHS_VideoCombine",
)
_missing_types = [t for t in _REQUIRED_TYPES if t not in obj_info]
if _missing_types:
    raise SystemExit(
        "Missing Comfy node types for InfiniteTalk: "
        + ", ".join(_missing_types)
        + ". Need kijai/ComfyUI-WanVideoWrapper on this pod "
        "(xxmachine auto-installs it when SSH works)."
    )


def resolve_source(origin_id, origin_slot, depth=0):
    if depth > 20:
        raise RuntimeError(f"Get/Set chain too deep at node {origin_id}")
    if node_type_by_id.get(origin_id) != "GetNode":
        return origin_id, origin_slot
    key = node_by_id[origin_id]["widgets_values"][0]
    set_id = set_node_by_key.get(key)
    if set_id is None:
        raise RuntimeError(f"GetNode {origin_id} (key={key}) has no matching SetNode")
    set_inputs = node_by_id[set_id].get("inputs", []) or []
    link_id = set_inputs[0].get("link") if set_inputs else None
    if link_id is None or link_id not in top_links:
        raise RuntimeError(f"SetNode {set_id} (key={key}) has no upstream link")
    l = top_links[link_id]
    return resolve_source(l[1], l[2], depth + 1)


def default_fill(node_inputs, ntype, linked_names):
    """Fill every non-connected widget (required AND optional) with its own
    current /object_info default -- see module docstring for why this
    replaces the positional widgets_values approach used elsewhere in this
    project.

    Optional fields are filled too, not just required ones: confirmed
    2026-07-23 that WanVideoVAELoader declares "precision" as optional (with
    a schema default of "bf16") but its own loadmodel() has no Python-level
    default for that parameter -- a real declaration/implementation mismatch
    in this actively-developed wrapper. Passing the schema's own default
    explicitly is harmless for true optionals and fixes this class of bug
    generically instead of special-casing one node."""
    if ntype not in obj_info:
        return
    inp = obj_info[ntype]["input"]
    all_fields = {**inp.get("required", {}), **inp.get("optional", {})}
    for name, spec in all_fields.items():
        if name in linked_names:
            continue
        typ = spec[0]
        if isinstance(typ, str) and typ in CONN_TYPES:
            continue
        opts = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
        if "default" in opts:
            node_inputs[name] = opts["default"]
        elif isinstance(typ, list) and typ:
            node_inputs[name] = typ[0]
        # no default and not a combo (e.g. a true optional connection-typed
        # slot, or an empty combo with no matching files on this pod) --
        # leave unset; either an explicit override fills it below, or a
        # still-missing required field surfaces as a clear error at submit.
        # else: no default and not a combo -- leave unset; submit will
        # surface it clearly as a missing-required-input error instead of
        # silently guessing.


api = {}
for n in nodes:
    if n["id"] in EXCLUDE_TOP or n["type"] in ("SetNode", "GetNode"):
        continue
    ntype = n["type"]
    if ntype not in obj_info:
        continue
    node_inputs = {}
    linked_names = set()
    for inp in n.get("inputs", []) or []:
        name = inp.get("name")
        link_id = inp.get("link")
        if link_id is None or link_id not in top_links:
            continue
        l = top_links[link_id]
        src_id, src_slot = resolve_source(l[1], l[2])
        node_inputs[name] = [str(src_id), src_slot]
        linked_names.add(name)
    default_fill(node_inputs, ntype, linked_names)
    api[str(n["id"])] = {"class_type": ntype, "inputs": node_inputs}

# ---- rewire the skipped vocal-isolation pass straight to LoadAudio ----
_embeds_key = str(MULTITALK_EMBEDS_NODE)
if _embeds_key not in api:
    raise SystemExit(
        f"ERROR: MultiTalkWav2VecEmbeds node {_embeds_key} missing from API graph "
        f"(type not registered on pod). Install ComfyUI-WanVideoWrapper / use a Talk pod."
    )
if str(LOAD_AUDIO_NODE) not in api:
    raise SystemExit(f"ERROR: LoadAudio node {LOAD_AUDIO_NODE} missing from API graph")
api[_embeds_key]["inputs"]["audio_1"] = [str(LOAD_AUDIO_NODE), 0]

# ---- per-job overrides (all key names verified against /object_info, see
# module docstring) ----
api[str(LOAD_IMAGE_NODE)]["inputs"]["image"] = INPUT_IMAGE
api[str(LOAD_AUDIO_NODE)]["inputs"]["audio"] = INPUT_AUDIO
api[str(SAVE_VIDEO_NODE)]["inputs"]["filename_prefix"] = OUTPUT_PREFIX
api[str(SAVE_VIDEO_NODE)]["inputs"]["frame_rate"] = 25.0
api[str(SAVE_VIDEO_NODE)]["inputs"]["format"] = "video/h264-mp4"

api[str(TEXT_ENCODE_NODE)]["inputs"]["model_name"] = TEXT_ENCODER_MODEL_NAME
api[str(TEXT_ENCODE_NODE)]["inputs"]["positive_prompt"] = PROMPT_TEXT
api[str(TEXT_ENCODE_NODE)]["inputs"]["negative_prompt"] = NEGATIVE_PROMPT_TEXT or DEFAULT_NEGATIVE

if USE_DISTILLED_LORA:
    api[str(LORA_SELECT_NODE)]["inputs"]["lora"] = LIGHTX2V_LORA_NAME
    api[str(LORA_SELECT_NODE)]["inputs"]["strength"] = 1.0
    # schema default is True, but our WanVideoModelLoader (122) loads a GGUF
    # quantized model -- GGUF doesn't support LoRA merging (confirmed via a real
    # submission error 2026-07-23: "GGUF models do not support LoRA merging,
    # please disable merge_loras"), despite the tooltip claiming this is handled
    # automatically.
    api[str(LORA_SELECT_NODE)]["inputs"]["merge_loras"] = False
else:
    api[str(WANVIDEO_MODEL_NODE)]["inputs"].pop("lora", None)

api[str(RESIZE_NODE)]["inputs"]["upscale_method"] = "lanczos"
api[str(RESIZE_NODE)]["inputs"]["keep_proportion"] = "crop"
api[str(RESIZE_NODE)]["inputs"]["crop_position"] = "center"
api[str(RESIZE_NODE)]["inputs"]["divisible_by"] = 16
api[str(RESIZE_WIDTH_NODE)]["inputs"]["value"] = WIDTH
api[str(RESIZE_HEIGHT_NODE)]["inputs"]["value"] = HEIGHT

api[str(IMAGE_TO_VIDEO_NODE)]["inputs"]["mode"] = "infinitetalk"
api[str(MAX_FRAMES_NODE)]["inputs"]["value"] = MAX_FRAMES

api[str(MULTITALK_MODEL_NODE)]["inputs"]["model"] = MULTITALK_MODEL_NAME
api[str(WANVIDEO_MODEL_NODE)]["inputs"]["model"] = WANVIDEO_MODEL_NAME
api[str(WANVIDEO_VAE_NODE)]["inputs"]["model_name"] = WANVIDEO_VAE_NAME

seed_used = int(SEED) if SEED else random.randint(0, 2**32 - 1)
api[str(SAMPLER_NODE)]["inputs"]["seed"] = seed_used
api[str(SAMPLER_NODE)]["inputs"]["steps"] = STEPS
api[str(SAMPLER_NODE)]["inputs"]["cfg"] = CFG
api[str(SAMPLER_NODE)]["inputs"]["shift"] = SHIFT

json.dump(api, open(OUTPUT_JSON, "w"), indent=2)
print(f"Built InfiniteTalk API workflow with {len(api)} nodes, image={INPUT_IMAGE}, "
      f"audio={INPUT_AUDIO}, seed={seed_used}, steps={STEPS}, cfg={CFG}")
print(f"SEED_USED={seed_used}")
