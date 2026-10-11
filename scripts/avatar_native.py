"""Compose the actual native 256px prediction; no guessed GAN tooth texture."""
import hashlib
import json
import cv2
import numpy as np


def batch_mels(frames):
    if not 1 <= len(frames) <= 2:
        raise ValueError('Expected one or two real audio frames')
    # Padding supplies a second model input only; callers emit real frames only.
    return np.ascontiguousarray(np.concatenate([frames[0].mel, frames[-1].mel], axis=0))


def verify_portrait_model(directory, photo):
    spec = json.loads((directory / 'native-source.json').read_text(encoding='utf-8'))
    if spec.get('nativeSize') != 256 or spec.get('photoSHA256') != hashlib.sha256(photo).hexdigest():
        raise ValueError('Native model does not match current portrait')
    region = spec.get('region')
    if not isinstance(region, list) or len(region) != 4 or any(type(n) is not int or n < 0 for n in region) or not all(region[2:]):
        raise ValueError('Invalid portrait region')
    for name in ('native.xml', 'native.bin'):
        if spec.get('files', {}).get(name) != hashlib.sha256((directory / name).read_bytes()).hexdigest():
            raise ValueError('Native model integrity check failed')
    return spec


class NativeMouth:
    def __init__(self, face, landmarks, lower_face=False):
        self.face = face.copy()
        self.height, self.width = face.shape[:2]
        self.lower_face = lower_face
        self.reference_gray = None
        center = np.asarray(landmarks[3:5]).mean(axis=0)
        span = float(np.linalg.norm(landmarks[4] - landmarks[3]))
        center[1] += span * .045
        mask = np.zeros((self.height, self.width), np.float32)
        cv2.ellipse(mask, tuple(np.round(center).astype(int)),
                    (int(span * .70), int(span * .415)), 0, 0, 360, 1, -1)
        mask = cv2.GaussianBlur(mask, (25, 25), 5)
        yy, xx = np.where(mask > .001)
        x, y = int(xx.min()), int(yy.min())
        w, h = int(xx.max() - x + 1), int(yy.max() - y + 1)
        if lower_face:
            yy, xx = np.mgrid[:self.height, :self.width].astype(np.float32)
            motion = np.exp(-((xx - center[0]) / (span * 1.05)) ** 4)
            motion *= np.exp(-((yy - (center[1] + span * .08)) / (span * .7)) ** 4)
            # Keep the eyes, nose bridge and crop edges stationary.
            motion *= np.clip((yy - landmarks[2, 1]) / (span * .25), 0, 1)
            motion *= np.clip(xx / 18, 0, 1) * np.clip((self.width - 1 - xx) / 18, 0, 1)
            motion *= np.clip((self.height - 1 - yy) / 18, 0, 1)
            ry, rx = np.where((motion > .001) | (mask > .001))
            x, y = int(rx.min()), int(ry.min())
            w, h = int(rx.max() - x + 1), int(ry.max() - y + 1)
            self.motion_mask = np.ascontiguousarray(motion[y:y+h, x:x+w], dtype=np.float32)
            self.map_x = np.ascontiguousarray(xx[y:y+h, x:x+w])
            self.map_y = np.ascontiguousarray(yy[y:y+h, x:x+w])
        self.region = x, y, w, h
        self.mask = mask[y:y+h, x:x+w, None]
        self.blend_mask = np.repeat(self.mask, 3, axis=2)
        self.inverse_blend_mask = 1 - self.blend_mask
        self.original = self.face[y:y+h, x:x+w]
        self.original_float = self.original.astype(np.float32)

    @staticmethod
    def _bgr(prediction):
        if prediction.shape != (1, 3, 256, 256) or prediction.dtype != np.float32 or not np.isfinite(prediction).all():
            raise ValueError('Invalid native mouth prediction')
        # Own a contiguous buffer before scaling; never modify shared model outputs.
        bgr = prediction[0].transpose(1, 2, 0).copy(order='C')
        bgr *= 255
        np.clip(bgr, 0, 255, out=bgr)
        return bgr

    @staticmethod
    def _gray(bgr):
        small = cv2.resize(bgr, (96, 96), interpolation=cv2.INTER_AREA).round().astype(np.uint8)
        return cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)

    def set_reference(self, prediction):
        self.reference_gray = self._gray(self._bgr(prediction))

    def render(self, prediction):
        bgr = self._bgr(prediction)
        restored = cv2.resize(bgr, (self.width, self.height), interpolation=cv2.INTER_CUBIC)
        x, y, w, h = self.region
        original = self.original_float
        if self.lower_face:
            if self.reference_gray is None:
                raise ValueError('Lower-face reference not prepared')
            # Reverse flow maps this generated shape to the still portrait's texture.
            # Always compare with the same silence reference; no temporal drift.
            gray = self._gray(bgr)
            # Numerical flow on identical low-contrast skin can otherwise create false motion.
            if not np.array_equal(gray, self.reference_gray):
                flow = cv2.calcOpticalFlowFarneback(gray, self.reference_gray, None, .5, 2, 15, 2, 5, 1.2, 0)
                flow = cv2.GaussianBlur(flow, (0, 0), 2.0)
                flow = cv2.resize(flow, (self.width, self.height), interpolation=cv2.INTER_LINEAR)[y:y+h, x:x+w]
                dx = np.clip(flow[:, :, 0] * (self.width / 96), -3.5, 3.5) * self.motion_mask
                dy = np.clip(flow[:, :, 1] * (self.height / 96), -3.5, 3.5) * self.motion_mask
                original = cv2.remap(self.face, self.map_x + dx, self.map_y + dy, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT_101).astype(np.float32)
        # Blend the native lips into the warped cheeks, avoiding a rectangular static seam.
        blended = cv2.add(cv2.multiply(restored[y:y+h, x:x+w], self.blend_mask),
                         cv2.multiply(original, self.inverse_blend_mask))
        np.clip(blended, 0, 255, out=blended)
        return blended.round().astype(np.uint8)

    def reset(self):
        # Every frame comes directly from its current audio; no texture history.
        pass
