"""Sightline optional local object detector (Ultralytics YOLO, COCO classes).

Private, loopback-only HTTP service used by src/server/vision/detector.ts. Standard library HTTP server,
no API keys, no logging of image content.

  POST /detect  JSON {frameId, capturedAt, width, height, image: base64 JPEG}
                -> {frameId, capturedAt, width, height, model, inferenceMs,
                    detections: [{label, score, box: {x, y, w, h}}]}   (box normalised 0..1, top-left origin)
  GET  /health  -> {ok: true, model}

COCO's 80 classes are generic objects (bottle, cup, bowl, banana, ...). This service cannot identify products,
read text or read dates. Boxes come only from the model; nothing is invented.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import io
import ipaddress
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODELS_DIR = HERE / "models"

# Keep Ultralytics' settings file (and its analytics "sync" flag) inside the git-ignored models dir, so we can
# disable usage analytics without touching the user's global Ultralytics settings.
os.environ.setdefault("YOLO_CONFIG_DIR", str(MODELS_DIR / ".ultralytics-config"))

MAX_BODY_BYTES = 3_000_000  # matches the backend's 2 MB base64 frame limit plus JSON overhead
MAX_IMAGE_DIM = 8192
DEFAULT_MODEL = "yolo26n.pt"


def load_model(model_name: str):
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    (MODELS_DIR / ".ultralytics-config").mkdir(parents=True, exist_ok=True)
    from ultralytics import YOLO, settings
    from ultralytics.utils.downloads import attempt_download_asset

    settings.update({"sync": False})  # no usage analytics from this service
    weights = MODELS_DIR / model_name
    if not weights.exists():
        print(f"Downloading {model_name} into {MODELS_DIR} (first run only)...", file=sys.stderr)
        attempt_download_asset(str(weights))
    if not weights.exists():
        raise SystemExit(f"Model weights not found and download failed: {weights}")
    return YOLO(str(weights))


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
    except Exception:  # noqa: BLE001 - fall back to CPU on any torch/MPS probe failure
        pass
    return "cpu"


class Detector:
    def __init__(self, model_name: str, device: str, imgsz: int, conf: float):
        self.model = load_model(model_name)
        self.model_label = Path(model_name).stem
        self.device = device
        self.imgsz = imgsz
        self.conf = conf
        self.lock = threading.Lock()  # one inference at a time; the model object is not thread-safe

    def warm_up(self) -> None:
        import numpy as np

        self.detect_array(np.zeros((self.imgsz, self.imgsz, 3), dtype=np.uint8))

    def detect_array(self, rgb):
        with self.lock:
            # Ultralytics treats numpy arrays as BGR (OpenCV convention); flip channels from RGB.
            results = self.model.predict(rgb[:, :, ::-1], imgsz=self.imgsz, conf=self.conf, device=self.device, verbose=False)
        out = []
        r = results[0]
        names = r.names
        boxes = r.boxes
        if boxes is None:
            return out
        for xyxyn, score, cls in zip(boxes.xyxyn.tolist(), boxes.conf.tolist(), boxes.cls.tolist()):
            x1, y1, x2, y2 = (min(1.0, max(0.0, float(v))) for v in xyxyn)
            out.append(
                {
                    "label": str(names[int(cls)]),
                    "score": round(float(score), 4),
                    "box": {"x": round(x1, 5), "y": round(y1, 5), "w": round(max(0.0, x2 - x1), 5), "h": round(max(0.0, y2 - y1), 5)},
                }
            )
        out.sort(key=lambda d: d["score"], reverse=True)
        return out


def decode_jpeg(b64: str):
    import numpy as np
    from PIL import Image

    raw = base64.b64decode(b64, validate=True)
    img = Image.open(io.BytesIO(raw))
    if img.format not in ("JPEG", "PNG"):
        raise ValueError("unsupported image format")
    if img.width > MAX_IMAGE_DIM or img.height > MAX_IMAGE_DIM:
        raise ValueError("image too large")
    return np.asarray(img.convert("RGB"))


def make_handler(detector: Detector):
    class Handler(BaseHTTPRequestHandler):
        server_version = "SightlineDetector/0.1"
        sys_version = ""

        def log_message(self, format, *args):  # noqa: A002 - signature from BaseHTTPRequestHandler
            # Metadata only (method, path, status). Never request bodies.
            sys.stderr.write(f"{self.log_date_time_string()} {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802
            if self.path.split("?")[0] == "/health":
                self._send(200, {"ok": True, "model": detector.model_label})
            else:
                self._send(404, {"error": "not_found"})

        def do_POST(self):  # noqa: N802
            if self.path.split("?")[0] != "/detect":
                self._send(404, {"error": "not_found"})
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                self.close_connection = True
                self._send(413 if length > MAX_BODY_BYTES else 400, {"error": "bad_length"})
                return
            try:
                payload = json.loads(self.rfile.read(length))
                frame_id = payload["frameId"]
                captured_at = payload["capturedAt"]
                image = payload["image"]
                if not isinstance(frame_id, int) or frame_id < 0 or not isinstance(captured_at, int) or not isinstance(image, str):
                    raise ValueError("bad fields")
                rgb = decode_jpeg(image)
            except (ValueError, KeyError, TypeError, binascii.Error, OSError):
                self._send(400, {"error": "invalid_request"})
                return
            t0 = time.perf_counter()
            try:
                detections = detector.detect_array(rgb)
            except Exception:  # noqa: BLE001 - report failure; never fabricate boxes
                self._send(500, {"error": "inference_failed"})
                return
            inference_ms = round((time.perf_counter() - t0) * 1000, 1)
            self._send(
                200,
                {
                    "frameId": frame_id,
                    "capturedAt": captured_at,
                    "width": int(rgb.shape[1]),
                    "height": int(rgb.shape[0]),
                    "model": detector.model_label,
                    "inferenceMs": inference_ms,
                    "detections": detections,
                },
            )

    return Handler


def main() -> None:
    p = argparse.ArgumentParser(description="Sightline local YOLO detector (loopback only)")
    p.add_argument("--host", default="127.0.0.1", help="IPv4 loopback address only (127.0.0.x)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--model", default=DEFAULT_MODEL, help="Ultralytics detect weights name, stored in ./models/")
    p.add_argument("--device", default="auto", help="auto | cpu | mps")
    p.add_argument("--imgsz", type=int, default=640)
    p.add_argument("--conf", type=float, default=0.30, help="Minimum confidence returned")
    p.add_argument("--download-only", action="store_true", help="Download the weights and exit")
    args = p.parse_args()

    addr = ipaddress.ip_address(args.host)
    if addr.version != 4 or not addr.is_loopback:
        raise SystemExit("Refusing to bind a non-loopback address: this service has no authentication.")

    if args.download_only:
        load_model(args.model)
        print(f"Weights ready in {MODELS_DIR}")
        return

    device = pick_device(args.device)
    detector = Detector(args.model, device, args.imgsz, args.conf)
    detector.warm_up()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(detector))
    print(f"Sightline detector ({detector.model_label}, device={device}) listening on http://{args.host}:{args.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
