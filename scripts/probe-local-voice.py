"""Exercise real Chinese synthesis and conversion using the user's reference."""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')
sys.path.insert(0, str(ROOT / '.runtime' / 'OpenVoice'))
import torch
from openvoice.api import BaseSpeakerTTS, OpenVoiceBaseClass, ToneColorConverter
import soundfile as sf

# Use OpenVoice's converter with the base initializer: no optional watermark model.
class LocalToneConverter(ToneColorConverter):
    def __init__(self, config):
        OpenVoiceBaseClass.__init__(self, str(config), device='cpu')
        self.watermark_model = None
        self.version = getattr(self.hps, '_version_', 'v1')

torch.set_num_threads(4)
models = ROOT / '.runtime' / 'openvoice-models' / 'checkpoints'
out = ROOT / '.private' / 'voice-runtime'
out.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
tts = BaseSpeakerTTS(str(models / 'base_speakers' / 'ZH' / 'config.json'), device='cpu')
tts.load_ckpt(str(models / 'base_speakers' / 'ZH' / 'checkpoint.pth'))
converter = LocalToneConverter(models / 'converter' / 'config.json')
converter.load_ckpt(str(models / 'converter' / 'checkpoint.pth'))
source = torch.load(models / 'base_speakers' / 'ZH' / 'zh_default_se.pth', map_location='cpu', weights_only=True)
target = converter.extract_se(str(ROOT / 'public' / 'assets' / 'voice-reference-clean.wav'))
print('Models ready in seconds:', round(time.monotonic() - started, 2), flush=True)
started = time.monotonic()
text = sys.argv[1] if len(sys.argv) > 1 else '你好，我是你的数字分身。现在可以用你的声音和你聊天了。'
base = out / 'base-probe.wav'
output = ROOT / 'output' / 'own-voice-probe.wav'
output.parent.mkdir(parents=True, exist_ok=True)
tts.tts(text, str(base), speaker='default', language='Chinese')
converter.convert(str(base), source, target, str(output))
data, rate = sf.read(output)
print(json.dumps({'output': str(output), 'sampleRate': rate, 'duration': round(len(data) / rate, 2), 'generationSeconds': round(time.monotonic() - started, 2), 'reference': 'voice-reference-clean.wav'}, ensure_ascii=True), flush=True)
