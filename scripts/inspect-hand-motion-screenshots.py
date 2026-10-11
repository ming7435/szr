"""Measure visible screen texture motion after verify-hand-motion-browser.mjs."""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

root = Path("output/hand-motion-visibility")
report = json.loads((root / "verification.json").read_text())
geometry = report["geometry"]
x, y, width, height = (int(geometry[key]) for key in ["x", "y", "width", "height"])
before = cv2.imread(str(root / "0.png"))[y:y+height, x:x+width]
peak = cv2.imread(str(root / "650.png"))[y:y+height, x:x+width]
flow = cv2.calcOpticalFlowFarneback(cv2.cvtColor(before, cv2.COLOR_BGR2GRAY), cv2.cvtColor(peak, cv2.COLOR_BGR2GRAY), None, .5, 3, 25, 4, 7, 1.5, 0)
cx, cy = int((545-190)*geometry["scale"]), int((1235-1070)*geometry["scale"])
central = flow[cy-16:cy+16, cx-18:cx+18]
report["visibleHandTextureMedianMovementCssPx"] = round(float(np.median(np.linalg.norm(central, axis=2))), 3)
report["visibleHandTextureMedianShiftCssPx"] = [round(float(v), 3) for v in np.median(central.reshape(-1, 2), axis=0)]
report["screenshotChangedPixels"] = int(np.count_nonzero(np.max(np.abs(before.astype(int)-peak.astype(int)), axis=2) > 5))
frames = [Image.open(root / f"{snapshot['elapsed']}.png").crop((x-25, y-35, x+width+25, y+height+25)).resize((852, 448)) for snapshot in report["snapshots"]]
# Runtime snapshots, shown forwards only; endpoint rest precedes the next loop.
frames[0].save(root / "preview.gif", save_all=True, append_images=frames[1:], duration=[200, 150, 150, 150, 200, 200, 250, 300, 300, 700], loop=0)
contact = Image.new("RGB", (852, 896), "white")
contact.paste(frames[0], (0, 0)); contact.paste(frames[4], (0, 448)); contact.save(root / "contact.jpg")
report["passed"] = report["passed"] and report["visibleHandTextureMedianMovementCssPx"] > 3
(root / "verification.json").write_text(json.dumps(report, indent=2))
print(json.dumps({key: report[key] for key in ["passed", "visibleHandTextureMedianMovementCssPx", "visibleHandTextureMedianShiftCssPx", "screenshotChangedPixels"]}))
assert report["passed"]
