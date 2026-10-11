"""Private JSON-lines worker: local ASR and fixed-reference voice synthesis."""
import base64
import contextlib
import io
import json
import logging
import os
import sys
import tempfile
import time
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.runtime' / 'OpenVoice'))
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
warnings.filterwarnings('ignore')
logging.disable(logging.CRITICAL)

def send(data):
    print(json.dumps(data, ensure_ascii=True), flush=True)

try:
    with contextlib.redirect_stdout(io.StringIO()):
        import numpy as np
        import soundfile as sf
        import librosa
        import torch
        from faster_whisper import WhisperModel
        from openvoice.api import BaseSpeakerTTS, OpenVoiceBaseClass, ToneColorConverter

        class LocalToneConverter(ToneColorConverter):
            def __init__(self, config):
                OpenVoiceBaseClass.__init__(self, str(config), device='cpu')
                self.watermark_model = None
                self.version = getattr(self.hps, '_version_', 'v1')

        # On this 14-core Windows CPU, eight threads reduce conversion time.
        torch.set_num_threads(min(8, os.cpu_count() or 4))
        torch.set_num_interop_threads(2)
        checkpoints = ROOT / '.runtime' / 'openvoice-models' / 'checkpoints'
        tts = BaseSpeakerTTS(str(checkpoints / 'base_speakers/ZH/config.json'), device='cpu')
        tts.load_ckpt(str(checkpoints / 'base_speakers/ZH/checkpoint.pth'))
        converter = LocalToneConverter(checkpoints / 'converter/config.json')
        converter.load_ckpt(str(checkpoints / 'converter/checkpoint.pth'))
        source = torch.load(checkpoints / 'base_speakers/ZH/zh_default_se.pth', map_location='cpu', weights_only=True)
        target = converter.extract_se(str(ROOT / 'public/assets/voice-reference-clean.wav'))
        recognizer = WhisperModel(str(ROOT / '.runtime/whisper-small'), device='cpu', compute_type='int8', cpu_threads=4, num_workers=1, local_files_only=True)
    send({'type': 'ready', 'voice': 'uploaded-reference', 'engine': 'openvoice-local'})
except Exception as error:
    if '--diagnostics' in sys.argv:
        import traceback
        traceback.print_exc(file=sys.stderr)
    send({'type': 'fatal', 'error': type(error).__name__})
    sys.exit(1)

runtime = ROOT / '.private' / 'voice-runtime'
runtime.mkdir(parents=True, exist_ok=True)
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        started = time.monotonic()
        with contextlib.redirect_stdout(io.StringIO()):
            if request.get('operation') == 'recognize':
                audio = base64.b64decode(request['audioBase64'], validate=True)
                samples, rate = sf.read(io.BytesIO(audio), dtype='float32')
                if samples.ndim != 1:
                    samples = samples.mean(axis=1)
                if rate != 16000:
                    samples = librosa.resample(samples, orig_sr=rate, target_sr=16000)
                segments, info = recognizer.transcribe(samples, language='zh', beam_size=3, vad_filter=True, condition_on_previous_text=False)
                text = ''.join(segment.text for segment in segments).strip()
                result = {'text': text, 'seconds': round(time.monotonic() - started, 2)}
            elif request.get('operation') == 'synthesize':
                text = request.get('text', '')
                if not isinstance(text, str) or not text.strip() or len(text) > 1200:
                    raise ValueError('invalid speech text')
                with tempfile.TemporaryDirectory(prefix='turn-', dir=runtime) as temporary:
                    base = Path(temporary) / 'base.wav'
                    tts.tts(text, str(base), speaker='default', language='Chinese')
                    audio = converter.convert(str(base), source, target)
                rate = converter.hps.data.sampling_rate
                if len(audio) < 100 or not np.isfinite(audio).all():
                    raise ValueError('invalid generated audio')
                output = io.BytesIO()
                sf.write(output, np.clip(audio, -0.98, 0.98), rate, format='WAV', subtype='PCM_16')
                result = {'audioBase64': base64.b64encode(output.getvalue()).decode('ascii'), 'mimeType': 'audio/wav', 'duration': round(len(audio) / rate, 2), 'seconds': round(time.monotonic() - started, 2), 'voice': 'uploaded-reference'}
            else:
                raise ValueError('unsupported operation')
        send({'id': request['id'], 'result': result})
    except Exception as error:
        send({'id': request.get('id'), 'error': type(error).__name__})
