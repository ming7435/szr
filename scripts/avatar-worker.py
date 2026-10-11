"""Personal/research live Wav2Lip inference; no video files or voice synthesis."""
import base64
from collections import deque
import json
from pathlib import Path
import sys
import threading

import cv2
import numpy as np
import openvino as ov
from avatar_features import AudioFrames
from avatar_native import NativeMouth, verify_portrait_model, batch_mels


def emit(event):
    print(json.dumps(event, separators=(",", ":")), flush=True)


def main():
    root = Path(sys.argv[1]).resolve()
    cv2.setNumThreads(1)
    image = cv2.imread(str(root / "public/assets/avatar.png"))
    if image is None:
        raise ValueError("Portrait unavailable")
    spec = verify_portrait_model(root / '.runtime/avatar-model', (root / 'public/assets/avatar.png').read_bytes())
    x, y, w, h = spec['region']
    if x+w > image.shape[1] or y+h > image.shape[0]:
        raise ValueError('Portrait crop exceeds image')
    face = image[y:y + h, x:x + w].copy()
    landmark_detector = cv2.FaceDetectorYN.create(
        str(root / '.runtime/avatar-model/yunet.onnx'), '',
        (image.shape[1], image.shape[0]), .8, .3, 5000)
    _, detected = landmark_detector.detect(image)
    if detected is None or len(detected) != 1:
        raise ValueError("Expected one aligned portrait face")
    landmarks = detected[0][4:14].reshape(5, 2) - [x, y]
    core = ov.Core()
    if "GPU" not in core.available_devices:
        raise ValueError("Intel GPU unavailable")
    compiled = core.compile_model(root / '.runtime/avatar-model/native.xml', 'GPU', {"PERFORMANCE_HINT": "LATENCY"})
    request = compiled.create_infer_request()
    detail = NativeMouth(face, landmarks, lower_face=True)
    rx, ry, rw, rh = detail.region

    def infer(mel):
        output = next(iter(request.infer([mel], share_inputs=True, share_outputs=True).values()))
        if output.shape != (2, 3, 256, 256):
            raise ValueError('Invalid native batch output')
        images = []
        for i in range(2):
            composite = detail.render(output[i:i+1])
            ok, encoded = cv2.imencode(".jpg", composite, [cv2.IMWRITE_JPEG_QUALITY, 96])
            if not ok:
                raise ValueError("Cannot encode mouth")
            images.append(base64.b64encode(encoded).decode("ascii"))
        return images

    # Normalized silent mel is -4; cache only its reference shape, never its speech.
    silent_mel = np.full((2, 1, 80, 16), -4, np.float32)
    reference = next(iter(request.infer([silent_mel], share_inputs=True, share_outputs=True).values()))
    if reference.shape != (2, 3, 256, 256):
        raise ValueError('Invalid native reference output')
    detail.set_reference(reference[0:1])
    detail.reset()
    emit({"type": "ready", "device": "GPU", "fps": 20, "sampleRate": 24000,
          "region": [x + rx, y + ry, rw, rh], "imageSize": [image.shape[1], image.shape[0]],
          "expressions": "basic-eye-brow", "mouthDetail": "native-256-fixed-portrait",
          "lowerFaceMotion": "audio-driven-photo-warp"})
    pending = deque(); condition = threading.Condition(); active = None; ended = False; pending_bytes = 0

    def read_input():
        nonlocal active, ended, pending_bytes
        try:
            for line in sys.stdin:
                if len(line) > 3 * 1024 * 1024:
                    raise ValueError("Command too large")
                event = json.loads(line)
                with condition:
                    if event["type"] in ("begin", "clear"):
                        active = event.get("id") if event["type"] == "begin" else None
                        pending.clear(); pending_bytes = 0
                    if pending_bytes + len(line) > 8 * 1024 * 1024:
                        raise ValueError("Queue too large")
                    pending.append((event, len(line))); pending_bytes += len(line); condition.notify()
        finally:
            with condition:
                active = None; ended = True; condition.notify()

    threading.Thread(target=read_input, daemon=True).start()
    stream = None; reply = None; batch = []
    while True:
        with condition:
            condition.wait_for(lambda: pending or ended)
            if ended:
                return
            event, size = pending.popleft(); pending_bytes -= size
        kind = event["type"]
        if kind == "begin":
            reply = event["id"]; stream = AudioFrames(fps=20); batch = []; detail.reset(); continue
        if kind == "clear":
            reply = None; stream = None; batch = []; detail.reset(); continue
        if kind == "warm":
            # Wake an idle GPU while the user speaks, without emitting sound or frames.
            # A new active reply takes priority and keeps its current mel/PCM untouched.
            if active is None:
                infer(silent_mel)
            continue
        if event.get("id") != reply or reply != active or stream is None:
            continue
        try:
            if kind == "audio":
                stream.push(base64.b64decode(event["pcm"], validate=True))
            elif kind != "finish":
                raise ValueError("Unknown command")
            def flush_batch():
                if reply != active:
                    batch.clear(); return
                images = infer(batch_mels(batch))
                for frame, jpeg in zip(batch, images):
                    if reply == active:
                        emit({"type": "frame", "id": reply, "index": frame.index,
                              "pcm": base64.b64encode(frame.pcm).decode("ascii"), "jpeg": jpeg})
                batch.clear()

            for frame in stream.pop_ready(finish=kind == "finish"):
                if reply != active:
                    batch.clear(); break
                batch.append(frame)
                if len(batch) == 2:
                    flush_batch()
            if kind == 'finish' and batch and reply == active:
                flush_batch()
            if kind == "finish" and reply == active:
                emit({"type": "finished", "id": reply})
        except Exception:
            if reply == active:
                emit({"type": "error", "id": reply})
            stream = None
            batch = []
            detail.reset()


if __name__ == "__main__":
    main()
