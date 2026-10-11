import sys
import unittest
from pathlib import Path

import librosa
import numpy as np
from scipy import signal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from avatar_features import AudioFrames


class StreamingAudioTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(712)
        t = np.arange(24000) / 24000
        self.pcm = ((.18 * np.sin(2 * np.pi * 157 * t) +
                     .03 * rng.standard_normal(len(t))) * 32767).astype("<i2").tobytes()

    def test_chunks_do_not_change_frames_or_original_voice_bytes(self):
        a, b = AudioFrames(), AudioFrames()
        a.push(self.pcm)
        whole = list(a.pop_ready(finish=True))
        chunked = []
        for start in range(0, len(self.pcm), 1378):
            b.push(self.pcm[start:start + 1378])
            chunked.extend(b.pop_ready())
        chunked.extend(b.pop_ready(finish=True))
        self.assertEqual(len(whole), 25)
        self.assertEqual(b"".join(f.pcm for f in chunked), self.pcm)
        for first, second in zip(whole, chunked):
            self.assertEqual(first.index, second.index)
            np.testing.assert_allclose(first.mel, second.mel, atol=.002)

    def test_real_features_match_publisher_librosa_reference(self):
        samples = signal.resample_poly(np.frombuffer(self.pcm, "<i2") / 32768, 2, 3)
        emphasis = signal.lfilter([1, -.97], [1], samples)
        spectrum = np.abs(librosa.stft(y=emphasis, n_fft=800, hop_length=200, win_length=800))
        basis = librosa.filters.mel(sr=16000, n_fft=800, n_mels=80, fmin=55, fmax=7600)
        db = 20 * np.log10(np.maximum(1e-5, basis @ spectrum)) - 20
        reference = np.clip(8 * ((db + 100) / 100) - 4, -4, 4)
        stream = AudioFrames(); stream.push(self.pcm)
        frames = list(stream.pop_ready())
        self.assertGreater(len(frames), 15)
        for frame in frames:
            start = int(frame.index * 80 / 25)
            np.testing.assert_allclose(frame.mel[0, 0], reference[:, start:start + 16], atol=.002)

    def test_short_tail_preserves_every_sample_and_limits_input(self):
        stream = AudioFrames(); sample = self.pcm[:482]
        stream.push(sample)
        self.assertEqual(list(stream.pop_ready()), [])
        frames = list(stream.pop_ready(finish=True))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0].pcm, sample)
        self.assertTrue(np.isfinite(frames[0].mel).all())
        with self.assertRaises(ValueError): AudioFrames().push(b"x")
        with self.assertRaises(ValueError): AudioFrames().push(bytes(24000 * 2 * 91))


if __name__ == "__main__":
    unittest.main()
