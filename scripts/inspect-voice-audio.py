"""Read-only measurements of supplied reference and prior cloned output, no upload."""
import json
import wave
from pathlib import Path

import numpy as np

report = {"cloudCalls": 0, "listeningTest": False, "files": {}}
for name in ["public/assets/voice-reference.wav", "public/assets/voice-reference-clean.wav", "output/doubao-live-reply.wav"]:
    with wave.open(name, "rb") as source:
        rate, channels = source.getframerate(), source.getnchannels()
        if source.getsampwidth() != 2:
            raise ValueError("Expected original 16-bit PCM")
        samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float64) / 32768
    report["files"][name] = {
        "rate": rate, "channels": channels,
        "seconds": round(len(samples) / rate / channels, 3),
        "peak": round(float(np.max(np.abs(samples))), 4),
        "rms": round(float(np.sqrt(np.mean(samples * samples))), 4),
        "clippedSamples": int(np.count_nonzero(np.abs(samples) > .995)),
        "dc": round(float(np.mean(samples)), 5),
    }
Path("output/voice-audio-inspection.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
print(json.dumps(report))
