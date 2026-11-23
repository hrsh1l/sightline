# Sightline optional object detector (local YOLO)

An **optional**, private, loopback-only HTTP service that draws generic object boxes (for the visual overlay) from
camera frames. Sightline works without it: if `DETECTOR_URL` is empty the detector is disabled and nothing else
changes. Gemini does all label reading, question answering and identification; this service never does.

- Model: Ultralytics **YOLO26n** (`yolo26n.pt`, COCO-pretrained, ~5.5 MB, 2.4 M params). YOLO26 is the current
  default Ultralytics detect family (https://docs.ultralytics.com/tasks/detect/, checked 2026-11-23).
- Runtime: PyTorch via the `ultralytics` package; Apple-silicon GPU (`mps`) when available, otherwise CPU.
- Server: Python standard-library `http.server.ThreadingHTTPServer`, bound to `127.0.0.1` only (non-loopback
  addresses are refused), no API keys, 3 MB request limit, one inference at a time, no request-body logging.

## What it can and cannot do

COCO's 80 classes are **generic objects** only. Kitchen-relevant ones include: bottle, wine glass, cup, fork,
knife, spoon, bowl, banana, apple, sandwich, orange, broccoli, carrot, hot dog, pizza, donut, cake, dining table,
microwave, oven, toaster, sink, refrigerator, cell phone, scissors.

It **cannot** identify products or brands, read text, read dates, tell a tin of tomatoes from a tin of beans, judge
freshness or doneness, or recognise anything outside those 80 classes (a jar is often "bottle" or "cup", a packet
may be nothing at all). Boxes are approximate and may be missing or wrong; they are an overlay hint, never a basis
for safety decisions. The service never invents boxes: it returns exactly what the model output above the
confidence threshold (0.35 by default; the Node client also filters at 0.35).

## Run it

Requires [`uv`](https://docs.astral.sh/uv/). The project pins Python 3.12 (`.python-version`) and exact package
versions (`pyproject.toml` + `uv.lock`); uv downloads Python 3.12 if needed.

From the repository root:

```sh
cd services/detector && uv sync && uv run python server.py --port 8765
```

`uv sync` installs ~1 GB (PyTorch) into `services/detector/.venv/` the first time. To fetch the weights ahead of
time instead of on first start: `uv run python server.py --download-only` (from `services/detector`).
The server prints `Sightline detector (yolo26n, device=mps) listening on http://127.0.0.1:8765` when ready.

The weights download once from the Ultralytics GitHub release
(`https://github.com/ultralytics/assets/releases/download/v8.4.0/yolo26n.pt`) into `services/detector/models/`,
which is git-ignored (as are `.venv/`, `*.pt` and `*.onnx`). Ultralytics' settings file is kept in
`models/.ultralytics-config/` and its usage-analytics `sync` option is switched off by `server.py`, so your global
Ultralytics settings are not touched.

Then enable it in the app's `.env` and restart the Node server:

```sh
DETECTOR_URL=http://127.0.0.1:8765
```

`GET /api/health` on the app reports `"detector": "ok"` when the service is reachable.

Options: `--device auto|cpu|mps` (default auto), `--imgsz 640`, `--conf 0.35`, `--model yolo26n.pt`,
`--host 127.0.0.1`, `--port 8765`.

## HTTP contract (used by `src/server/vision/detector.ts`)

`POST /detect`

```json
{ "frameId": 12, "capturedAt": 1795000000000, "width": 768, "height": 1024, "image": "<base64 JPEG, no data: prefix>" }
```

Response `200`:

```json
{
  "frameId": 12, "capturedAt": 1795000000000, "width": 768, "height": 1024,
  "model": "yolo26n", "inferenceMs": 27.1,
  "detections": [ { "label": "bottle", "score": 0.91, "box": { "x": 0.10, "y": 0.20, "w": 0.20, "h": 0.50 } } ]
}
```

Boxes are normalised 0..1 relative to the decoded image (top-left origin, not mirrored), sorted by score.
Errors: `400 {"error":"invalid_request"}`, `413 {"error":"bad_length"}`, `500 {"error":"inference_failed"}`,
`404 {"error":"not_found"}`.

`GET /health` -> `{"ok": true, "model": "yolo26n"}`

The Node client sends at most one request at a time and at most one per second, times out after 1.5 s, rejects
responses whose `frameId` does not match, and pauses for 30 s after 3 consecutive failures.

## Measured on this Mac (2026-11-23)

Apple M1 Max, Python 3.12.14, torch 2.15.0, ultralytics 8.4.218, `yolo26n.pt`, imgsz 640, the
`bus.jpg` sample image bundled with the ultralytics package (810x1080 JPEG):

| Device | Model inference (server-reported) | HTTP round trip from the Node client |
|---|---|---|
| `mps` (default on Apple silicon) | 25-30 ms steady state (first request ~360 ms warm-up) | 30-61 ms (10 requests, 1/s) |
| `cpu` (`--device cpu`) | 37-47 ms | 42-55 ms (curl, 7 requests) |

Detections on `bus.jpg`: bus 0.88, person 0.87, person 0.86, person 0.85, person 0.65. Real kitchen scenes have
not been measured.

## Licence (read before distributing)

- The `ultralytics` package is licensed **AGPL-3.0** (PyPI metadata for ultralytics 8.4.218:
  `License: AGPL-3.0`; https://pypi.org/project/ultralytics/).
- Ultralytics states: "All Ultralytics YOLO trained models fall under the AGPL-3.0 License by default", and that
  the licence "covers the training code and the models produced by that training code"
  (https://www.ultralytics.com/license). That page treats SaaS, APIs and other networked deployments that use
  YOLO behind the scenes as requiring either full AGPL-3.0 compliance (publishing the complete corresponding source of
  the derivative work) or a paid **Ultralytics Enterprise License**.
- Implication for Sightline: running this service locally for a demo is fine, but distributing it, or offering
  Sightline with this detector to other people over a network, would require AGPL-3.0 compliance for the combined
  work or an Enterprise License. This service is a separate process reached over local HTTP and is off by default.
  Whether that separation matters legally is a question for a lawyer; the safe assumption is that it does not.
- The pretrained weights were trained on COCO; see the COCO terms of use (https://cocodataset.org/#termsofuse) for
  dataset terms (not re-verified here).
- Other runtime packages, per their installed package metadata: torch 2.15.0 `Apache-2.0 AND BSD-3-Clause AND ...`
  (multiple permissive licences), opencv-python 5.1.0.95 `Apache 2.0`, pillow 13.0.0 `MIT-CMU`.
