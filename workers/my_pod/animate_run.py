"""
Animate sidecar for xxmachine My Pod control plane.
Runs on the VPS (not on the pod). Talks to remote Comfy via COMFY_URL.
Builds multi-window WAN Animate graph via build_api.py, submits, polls, prints DONE.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188").rstrip("/")
COMFY_API_TOKEN = os.environ.get("COMFY_API_TOKEN", "").strip()
BUILD_SCRIPT = os.path.join(os.path.dirname(__file__), "build_api.py")
POLL_INTERVAL_SEC = 5
TIMEOUT_SEC = int(os.environ.get("JOB_TIMEOUT_SEC", "3600"))
FINAL_SAVEVIDEO_NODE_ID = "9999"


def _req(url, data=None, method=None):
    headers = {"Content-Type": "application/json"} if data is not None else {}
    if COMFY_API_TOKEN:
        headers["Authorization"] = f"Bearer {COMFY_API_TOKEN}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    return urllib.request.urlopen(req, timeout=30)


def build_prompt():
    env = os.environ.copy()
    env.setdefault("OUTPUT_JSON", "/tmp/xxm_api_workflow.json")
    # Default workflow path for control-plane layout
    env.setdefault(
        "WORKFLOW_PATH",
        os.path.join(os.path.dirname(__file__), "templates", "Wan22_Animate.json"),
    )
    result = subprocess.run([sys.executable, BUILD_SCRIPT], env=env, capture_output=True, text=True)
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise RuntimeError(f"build_api.py failed: {result.stderr[-1500:]}")
    return env["OUTPUT_JSON"]


def submit(prompt_path):
    api = json.load(open(prompt_path))
    payload = json.dumps({"prompt": api}).encode()
    try:
        with _req(f"{COMFY_URL}/prompt", data=payload) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        raise RuntimeError(f"submit failed: HTTP {e.code}: {body[:2000]}")
    if resp.get("node_errors"):
        raise RuntimeError(f"submit rejected with node_errors: {json.dumps(resp['node_errors'])[:2000]}")
    return resp["prompt_id"]


def wait_for_result(prompt_id):
    deadline = time.time() + TIMEOUT_SEC
    while time.time() < deadline:
        try:
            with _req(f"{COMFY_URL}/history/{prompt_id}") as r:
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
                out = outputs.get(FINAL_SAVEVIDEO_NODE_ID)
                if out:
                    for key in ("images", "gifs", "videos"):
                        for f in out.get(key, []):
                            name = f.get("filename", "")
                            if name.lower().endswith((".mp4", ".webm")):
                                return name, f.get("subfolder", "") or "-"
                raise RuntimeError(
                    f"job completed but node {FINAL_SAVEVIDEO_NODE_ID} has no video: {json.dumps(outputs)[:1500]}"
                )
            if status.get("status_str") == "error":
                raise RuntimeError(f"job failed: {json.dumps(status)[:2000]}")
        time.sleep(POLL_INTERVAL_SEC)
    raise TimeoutError(f"job {prompt_id} did not finish within {TIMEOUT_SEC}s")


def main():
    if not os.environ.get("IMAGE_FILE") or not os.environ.get("DRIVING_FILE"):
        raise SystemExit("IMAGE_FILE and DRIVING_FILE required")
    prompt_path = build_prompt()
    prompt_id = submit(prompt_path)
    print(f"submitted prompt_id={prompt_id}")
    filename, subfolder = wait_for_result(prompt_id)
    print(f"DONE filename={filename} subfolder={subfolder} type=output")


if __name__ == "__main__":
    main()
