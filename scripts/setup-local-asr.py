"""Download the upstream faster-whisper small checkpoint for local recognition."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.runtime' / 'whisper-small'
REPO = 'Systran/faster-whisper-small'
with urllib.request.urlopen(f'https://huggingface.co/api/models/{REPO}?blobs=true', timeout=30) as reply:
    info = json.load(reply)
metadata = {item['rfilename']: item for item in info['siblings']}
files = [name for name in ['config.json', 'model.bin', 'tokenizer.json', 'vocabulary.json', 'vocabulary.txt', 'preprocessor_config.json'] if name in metadata]
DEST.mkdir(parents=True, exist_ok=True)
for name in files:
    expected = metadata[name].get('lfs', {}).get('sha256')
    target = DEST / name
    if target.exists() and (not expected or hashlib.sha256(target.read_bytes()).hexdigest() == expected):
        print('Ready:', name, flush=True)
        continue
    print('Downloading:', name, flush=True)
    partial = target.with_suffix(target.suffix + '.partial')
    digest = hashlib.sha256()
    with urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{info["sha"]}/{name}?download=true', timeout=45) as source, partial.open('wb') as output:
        while block := source.read(1024 * 1024):
            output.write(block)
            digest.update(block)
    if expected and digest.hexdigest() != expected:
        raise RuntimeError('Checksum failed: ' + name)
    partial.replace(target)
    print('Saved:', name, target.stat().st_size, flush=True)
(DEST / 'source.json').write_text(json.dumps({'repo': REPO, 'revision': info['sha'], 'files': files}, indent=2), encoding='utf-8')
