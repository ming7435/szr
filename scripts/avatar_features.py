"""Bounded audio windows for Wav2Lip. PCM output is always the original bytes."""
from dataclasses import dataclass
import numpy as np
from scipy import signal

RATE = 24000
FPS = 25
SAMPLES_PER_FRAME = RATE // FPS
MAX_BYTES = RATE * 2 * 90


def mel_basis():
    def to_mel(hz):
        hz = np.asarray(hz, dtype=float)
        return np.where(hz >= 1000, 15 + np.log(np.maximum(hz, 1) / 1000) / (np.log(6.4) / 27), hz / (200 / 3))
    values = np.linspace(to_mel(55), to_mel(7600), 82)
    frequencies = np.where(values >= 15, 1000 * np.exp((values - 15) * np.log(6.4) / 27), values * (200 / 3))
    differences = np.diff(frequencies)
    ramps = frequencies[:, None] - np.arange(401)[None, :] * 20
    weights = np.maximum(0, np.minimum(-ramps[:-2] / differences[:-1, None],
                                       ramps[2:] / differences[1:, None]))
    return (weights * (2 / (frequencies[2:] - frequencies[:-2]))[:, None]).astype(np.float32)


BASIS = mel_basis()
WINDOW = signal.get_window("hann", 800, fftbins=True)


@dataclass
class AudioFrame:
    index: int
    mel: np.ndarray
    pcm: bytes


class AudioFrames:
    def __init__(self, fps=FPS):
        if fps not in (20, 25):
            raise ValueError('Unsupported frame rate')
        self.fps = fps
        self.samples_per_frame = RATE // fps
        self.pcm = bytearray()
        self.next_index = 0
        self.finished = False

    def push(self, data):
        if self.finished or not data or len(data) % 2 or len(self.pcm) + len(data) > MAX_BYTES:
            raise ValueError("Invalid or excessive PCM audio")
        self.pcm.extend(data)

    def pop_ready(self, finish=False):
        self.finished |= finish
        count = len(self.pcm) // 2
        while self.next_index * self.samples_per_frame < count:
            index = self.next_index
            mel_start = int(index * 80 / self.fps)
            # 16 mel windows, STFT future context, and polyphase filter margin.
            end = mel_start * 300 + 5250
            if not self.finished and count < end:
                break
            first = max(0, mel_start * 300 - 750)
            snippet = np.frombuffer(bytes(self.pcm[first * 2:min(end, count) * 2]), "<i2").astype(np.float64) / 32768
            if len(snippet) < end - first:
                snippet = np.pad(snippet, (0, end - first - len(snippet)))
            resampled = signal.resample_poly(snippet, 2, 3)
            emphasized = signal.lfilter([1, -.97], [1], resampled)
            origin = first * 2 // 3
            windows = []
            if origin == 0:
                emphasized = np.pad(emphasized, (400, 0))
                offset = 400
            else:
                offset = 0
            for j in range(16):
                center = (mel_start + j) * 200 - origin + offset
                windows.append(emphasized[center - 400:center + 400])
            spectrum = np.abs(np.fft.rfft(np.asarray(windows) * WINDOW, axis=1)).T
            db = 20 * np.log10(np.maximum(1e-5, BASIS @ spectrum)) - 20
            mel = np.clip(8 * ((db + 100) / 100) - 4, -4, 4).astype(np.float32)[None, None]
            audio = bytes(self.pcm[index * self.samples_per_frame * 2:min((index + 1) * self.samples_per_frame, count) * 2])
            self.next_index += 1
            yield AudioFrame(index=index, mel=np.ascontiguousarray(mel), pcm=audio)
