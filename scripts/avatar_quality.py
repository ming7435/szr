"""Local mouth restoration with motion-guided detail between keyframes.

Every frame uses the current Wav2Lip prediction. Restoration supplies texture;
it never substitutes a prerecorded mouth animation or alters audio.
"""
import cv2
import numpy as np


ARC_TEMPLATE = np.array([
    [.36167656, .40387734], [.63696719, .40235469],
    [.50019687, .56044219], [.38710391, .72160547],
    [.61507734, .72034453],
], np.float32) * 256


class MouthDetail:
    def __init__(self, face, landmarks, restore):
        if face.dtype != np.uint8 or landmarks.shape != (5, 2) or not np.isfinite(landmarks).all():
            raise ValueError("Invalid portrait alignment")
        self.face = face.copy()
        self.restore = restore
        self.height, self.width = face.shape[:2]
        self.affine = cv2.estimateAffinePartial2D(
            landmarks.astype(np.float32), ARC_TEMPLATE,
            method=cv2.RANSAC, ransacReprojThreshold=100)[0]
        if self.affine is None or not np.isfinite(self.affine).all():
            raise ValueError("Cannot align portrait")
        center = landmarks[3:].mean(axis=0)
        span = float(np.linalg.norm(landmarks[4] - landmarks[3]))
        center[1] += span * .045
        axes = (round(span * .70), round(span * .415))
        mask = np.zeros((self.height, self.width), np.float32)
        cv2.ellipse(mask, tuple(np.rint(center).astype(int)), axes, 0, 0, 360, 1, -1)
        mask = cv2.GaussianBlur(mask, (25, 25), 5)
        points = np.argwhere(mask > 0)
        y, x = points.min(axis=0)
        bottom, right = points.max(axis=0) + 1
        self.region = (int(x), int(y), int(right-x), int(bottom-y))
        self.mask = mask[y:bottom, x:right, None]
        self.original = face[y:bottom, x:right].astype(np.float32)
        self.original_aligned = cv2.warpAffine(face, self.affine, (256, 256),
            flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        self.aligned_mask = cv2.warpAffine(mask, self.affine, (256, 256))[:, :, None]
        self.inverse = cv2.invertAffineTransform(self.affine)
        self.inverse[:, 2] -= [x, y]
        width, height = self.region[2:]
        self.xx, self.yy = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
        self.flow_x = (self.xx + x + .5) * 96 / self.width - .5
        self.flow_y = (self.yy + y + .5) * 96 / self.height - .5
        self.reset()

    def reset(self):
        self.key_low = self.key_detail = None
        self.index = 0

    def render(self, low):
        if low.shape != (96, 96, 3) or low.dtype != np.uint8:
            raise ValueError("Invalid lip prediction")
        x, y, width, height = self.region
        generated = cv2.resize(low, (self.width, self.height), interpolation=cv2.INTER_CUBIC)
        if self.key_low is None or self.index % 2 == 0:
            aligned = cv2.warpAffine(generated, self.affine, (256, 256),
                flags=cv2.INTER_AREA, borderMode=cv2.BORDER_REPLICATE)
            aligned = np.clip(aligned * self.aligned_mask +
                self.original_aligned * (1-self.aligned_mask), 0, 255).astype(np.uint8)
            restored = self.restore(aligned)
            if restored.shape != (256, 256, 3) or restored.dtype != np.uint8:
                raise ValueError("Invalid restored mouth")
            detail = cv2.warpAffine(restored, self.inverse, (width, height),
                flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            self.key_low, self.key_detail = low.copy(), detail.copy()
        else:
            # Backward flow maps the current audio-driven shape to the last
            # restored texture. Holding a keyframe would freeze phonemes.
            flow = cv2.calcOpticalFlowFarneback(
                cv2.cvtColor(low, cv2.COLOR_BGR2GRAY),
                cv2.cvtColor(self.key_low, cv2.COLOR_BGR2GRAY),
                None, .5, 2, 15, 3, 5, 1.2, 0)
            motion = cv2.remap(flow, self.flow_x, self.flow_y, cv2.INTER_LINEAR)
            detail = cv2.remap(self.key_detail,
                self.xx + motion[:, :, 0] * self.width / 96,
                self.yy + motion[:, :, 1] * self.height / 96,
                cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
            warped_low = cv2.remap(self.key_low,
                self.flow_x + motion[:, :, 0], self.flow_y + motion[:, :, 1],
                cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            # Retain current mouth opening/colour when a surface is revealed.
            residual = generated[y:y+height, x:x+width].astype(np.float32) - warped_low.astype(np.float32)
            detail += cv2.GaussianBlur(residual, (9, 9), 2)
        self.index += 1
        return np.clip(detail * self.mask + self.original * (1-self.mask), 0, 255).astype(np.uint8)
