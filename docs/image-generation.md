# 图像素材记录

本轮曾使用内置 image_gen 生成最初白背景肖像的表情帧。用户随后指定了新图片，因此 V1 使用 `public/assets/avatar.png`（用户最新原图），不使用先前表情帧。

保留的参考资产：`public/assets/portrait.jpg` 与 `public/assets/expression.png`。表情帧由内置工具生成，提示词：

> Use case: identity-preserve. Edit target: attached exact portrait photograph. Create ONE edited portrait frame for a photo-driven talking avatar animation. Preserve the exact same person, facial identity, bone structure, head position, camera angle, lighting, skin tone, haircut, black T-shirt, white background and composition. Change ONLY expression: BOTH eyes gently closed in a natural blink, and mouth open modestly as if pronouncing a short 'ah', about 8 mm gap, natural upper teeth slightly visible. No broad smile. Keep entire nose, jaw, eyebrow position, hairstyle, face proportions, neck and torso perfectly unchanged. Keep the same aspect ratio and framing as reference, aligned to original as precisely as possible. Photorealistic, realistic oral cavity and eyelids, no beautification, no stylization, no accessories, no typography. This is an animation source frame, so retaining all untouched pixel positions and the exact identity is critical.
