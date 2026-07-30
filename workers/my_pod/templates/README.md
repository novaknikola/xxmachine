# My Pod workflow templates (source of truth on xxmachine VPS)

Place / keep these files here:

- `Wan22_I2V_api_template.json` — ComfyUI **API-format** export of WAN 2.2 I2V
- `Wan22_Animate.json` — ComfyUI **UI-format** WAN 2.2 Animate workflow (used by `build_api.py`)

Override paths with env:
- `MY_POD_I2V_TEMPLATE_PATH`
- `MY_POD_ANIMATE_WORKFLOW_PATH`
- `MY_POD_PYTHON` (default `python3`)
