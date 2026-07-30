"""
InfiniteTalk sidecar for xxmachine My Pod.
Builds graph via build_infinitetalk_api.py, submits to remote Comfy, prints DONE.
Env: COMFY_URL, INPUT_IMAGE, INPUT_AUDIO, OUTPUT_PREFIX, JOB_TIMEOUT_SEC, WORKFLOW_PATH
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_API_TOKEN = os.environ.get("COMFY_API_TOKEN", "").strip()
BUILD_SCRIPT = os.path.join(os.path.dirname(__file__), "build_infinitetalk_api.py")
POLL_INTERVAL_SEC = 5
# Sheets poller uses 900s — InfiniteTalk distilled path is ~3–4 min/clip.
TIMEOUT_SEC = int(os.environ.get("JOB_TIMEOUT_SEC", "900"))
SAVE_VIDEO_NODE = "131"
UA = "xxmachine-my-pod/1.0"


def _req(url, data=None):
    headers = {"User-Agent": UA}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if COMFY_API_TOKEN:
        headers["Authorization"] = f"Bearer {COMFY_API_TOKEN}"
    return urllib.request.Request(url, data=data, headers=headers)


def build_prompt():
    env = os.environ.copy()
    env.setdefault("OUTPUT_JSON", "/tmp/xxm_infinitetalk.json")
    env.setdefault(
        "WORKFLOW_PATH",
        os.path.join(os.path.dirname(__file__), "templates", "wanvideo_infinitetalk_template.json"),
    )
    result = subprocess.run([sys.executable, BUILD_SCRIPT], env=env, capture_output=True, text=True)
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"build_infinitetalk_api.py failed: {result.stderr[-2000:]}")
    return env["OUTPUT_JSON"]


def submit(prompt_path):
    api = json.load(open(prompt_path))
    payload = json.dumps({"prompt": api}).encode()
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(_req(f"{COMFY_URL}/prompt", data=payload), timeout=60) as r:
                resp = json.loads(r.read())
            if resp.get("node_errors"):
                raise RuntimeError(f"node_errors: {json.dumps(resp['node_errors'])[:2000]}")
            return resp["prompt_id"]
        except urllib.error.HTTPError as e:
            body = e.read().decode()
            raise RuntimeError(f"submit failed: HTTP {e.code}: {body[:2000]}")
        except Exception as e:
            last_err = e
            print(f"submit attempt {attempt + 1}/3 failed: {e}")
            time.sleep(10)
    raise RuntimeError(f"submit failed after 3 attempts: {last_err}")


def wait_for_result(prompt_id):
    deadline = time.time() + TIMEOUT_SEC
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(_req(f"{COMFY_URL}/history/{prompt_id}"), timeout=15) as r:
                hist = json.loads(r.read())
        except Exception as e:
            print(f"history check failed: {e}")
            time.sleep(POLL_INTERVAL_SEC)
            continue
        entry = hist.get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("completed") or status.get("status_str") == "success":
                outputs = entry.get("outputs", {})
                # Prefer save node 131, else any video
                preferred = outputs.get(SAVE_VIDEO_NODE, {})
                for key in ("gifs", "images", "videos"):
                    for f in preferred.get(key, []):
                        name = f.get("filename", "")
                        if name.lower().endswith((".mp4", ".webm")):
                            return name, f.get("subfolder", "") or "-"
                for out in outputs.values():
                    for key in ("gifs", "images", "videos"):
                        for f in out.get(key, []):
                            name = f.get("filename", "")
                            if name.lower().endswith((".mp4", ".webm")):
                                return name, f.get("subfolder", "") or "-"
                raise RuntimeError(f"completed but no video: {json.dumps(outputs)[:1500]}")
            if status.get("status_str") == "error":
                raise RuntimeError(f"job failed: {json.dumps(status)[:2000]}")
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"job {prompt_id} did not finish within {TIMEOUT_SEC}s")


def main():
    if not os.environ.get("INPUT_IMAGE") or not os.environ.get("INPUT_AUDIO"):
        raise SystemExit("INPUT_IMAGE and INPUT_AUDIO required")
    path = build_prompt()
    prompt_id = submit(path)
    print(f"submitted prompt_id={prompt_id}")
    filename, subfolder = wait_for_result(prompt_id)
    print(f"DONE filename={filename} subfolder={subfolder} type=output")


if __name__ == "__main__":
    main()
