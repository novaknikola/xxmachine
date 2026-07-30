"""
Optional I2V Python sidecar (xxmachine also has a TypeScript path).
Patches Wan22_I2V_api_template.json and drives remote Comfy via COMFY_URL.
Prints: DONE filename=... subfolder=...
"""
import json
import os
import random
import time
import urllib.request

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_API_TOKEN = os.environ.get("COMFY_API_TOKEN", "").strip()
TEMPLATE_PATH = os.environ.get(
    "I2V_WORKFLOW_API_PATH",
    os.path.join(os.path.dirname(__file__), "templates", "Wan22_I2V_api_template.json"),
)
POLL_INTERVAL_SEC = 5
TIMEOUT_SEC = int(os.environ.get("JOB_TIMEOUT_SEC", "3600"))

NODE_IDS = {
    "load_image": "44",
    "positive_prompt": "24",
    "negative_prompt": "25",
    "image_to_video": "43",
    "save_video": "16",
    "sampler_high_noise": "49",
    "sampler_low_noise": "50",
}

DEFAULT_POSITIVE_PROMPT = "woman smiling and tilting head slowly, subtle natural movement"
IMAGE_FILE = os.environ["IMAGE_FILE"]
POSITIVE_PROMPT = os.environ.get("POSITIVE_PROMPT") or DEFAULT_POSITIVE_PROMPT
NEGATIVE_PROMPT = os.environ.get("NEGATIVE_PROMPT", "")
SEED = os.environ.get("SEED")
WIDTH = int(os.environ.get("I2V_WIDTH", "480"))
HEIGHT = int(os.environ.get("I2V_HEIGHT", "832"))
OUTPUT_PREFIX = os.environ.get("OUTPUT_PREFIX", "i2v/i2v_job")


def _req(url, data=None):
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if COMFY_API_TOKEN:
        headers["Authorization"] = f"Bearer {COMFY_API_TOKEN}"
    req = urllib.request.Request(url, data=data, headers=headers)
    return urllib.request.urlopen(req, timeout=30)


def build_prompt():
    api = json.load(open(TEMPLATE_PATH))
    api[NODE_IDS["load_image"]]["inputs"]["image"] = IMAGE_FILE
    api[NODE_IDS["positive_prompt"]]["inputs"]["text"] = POSITIVE_PROMPT
    if NEGATIVE_PROMPT:
        api[NODE_IDS["negative_prompt"]]["inputs"]["text"] = NEGATIVE_PROMPT
    api[NODE_IDS["image_to_video"]]["inputs"]["width"] = WIDTH
    api[NODE_IDS["image_to_video"]]["inputs"]["height"] = HEIGHT
    seed_used = int(SEED) if SEED else random.randint(0, 2**32 - 1)
    for key in ("sampler_high_noise", "sampler_low_noise"):
        node_id = NODE_IDS.get(key)
        if node_id and node_id in api:
            api[node_id]["inputs"]["noise_seed"] = seed_used
    api[NODE_IDS["save_video"]]["inputs"]["filename_prefix"] = OUTPUT_PREFIX
    return api, seed_used


def submit(api):
    payload = json.dumps({"prompt": api}).encode()
    with _req(f"{COMFY_URL}/prompt", data=payload) as r:
        resp = json.loads(r.read())
    if resp.get("node_errors"):
        raise RuntimeError(f"node_errors: {json.dumps(resp['node_errors'])[:2000]}")
    return resp["prompt_id"]


def wait_for_result(prompt_id):
    save_node = NODE_IDS["save_video"]
    deadline = time.time() + TIMEOUT_SEC
    while time.time() < deadline:
        with _req(f"{COMFY_URL}/history/{prompt_id}") as r:
            hist = json.loads(r.read())
        entry = hist.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "success":
                out = entry.get("outputs", {}).get(save_node, {})
                for key in ("gifs", "images", "videos"):
                    for f in out.get(key, []):
                        name = f.get("filename", "")
                        if name.lower().endswith((".webm", ".mp4", ".gif")):
                            return name, f.get("subfolder", "") or "-"
                raise RuntimeError(f"no video in node {save_node}")
            if status.get("status_str") == "error":
                raise RuntimeError(json.dumps(status)[:2000])
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"timeout {TIMEOUT_SEC}s")


def main():
    api, seed = build_prompt()
    prompt_id = submit(api)
    print(f"submitted prompt_id={prompt_id} seed={seed}")
    filename, subfolder = wait_for_result(prompt_id)
    print(f"DONE filename={filename} subfolder={subfolder} type=output")


if __name__ == "__main__":
    main()
