"""Download only the Chinese and converter checkpoints from the publisher."""
import hashlib
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.runtime' / 'openvoice-models'
REPO = 'myshell-ai/OpenVoice'
FILES = [
    'checkpoints/base_speakers/ZH/config.json',
    'checkpoints/base_speakers/ZH/checkpoint.pth',
    'checkpoints/base_speakers/ZH/zh_default_se.pth',
    'checkpoints/converter/config.json',
    'checkpoints/converter/checkpoint.pth',
]

def main():
    with urllib.request.urlopen(f'https://huggingface.co/api/models/{REPO}?blobs=true', timeout=30) as reply:
        info = json.load(reply)
    revision = info['sha']
    metadata = {item['rfilename']: item for item in info['siblings']}
    for name in FILES:
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        expected = metadata[name].get('lfs', {}).get('sha256')
        if target.exists() and (not expected or hashlib.sha256(target.read_bytes()).hexdigest() == expected):
            print('Ready:', name, flush=True)
            continue
        print('Downloading:', name, flush=True)
        partial = target.with_suffix(target.suffix + '.partial')
        digest = hashlib.sha256()
        with urllib.request.urlopen(f'https://huggingface.co/{REPO}/resolve/{revision}/{name}?download=true', timeout=45) as source, partial.open('wb') as output:
            while block := source.read(1024 * 1024):
                output.write(block)
                digest.update(block)
        if expected and digest.hexdigest() != expected:
            raise RuntimeError('Checkpoint checksum failed: ' + name)
        partial.replace(target)
        print('Saved:', name, target.stat().st_size, flush=True)
    (DEST / 'source.json').write_text(json.dumps({'repo': REPO, 'revision': revision, 'files': FILES}, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
