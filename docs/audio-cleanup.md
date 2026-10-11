# 上传录音降噪 — 2026-10-08

输入为 `C:/Users/12587/Downloads/10月8日 2.m4a`，原始文件未改动。项目内的 `public/assets/voice-reference.m4a`、`voice-reference.wav` 保留为处理前版本。

页面试听改用 `public/assets/voice-reference-clean.m4a`；专属音色创建接口改用同一处理结果的无损版本 `public/assets/voice-reference-clean.wav`（24 kHz、单声道、16-bit PCM）。人物照片继续使用第二张照片。

在本机用 FFmpeg 8.1.2 处理：先转换为 48 kHz 单声道，以 65 Hz 高通削弱低频震动，再使用 RNNoise 人声降噪模型，最后输出 WAV 和试听用 M4A。没有添加变调、变速、混响或另一种合成声音；本次处理没有上传用户录音。

模型来自 [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models)，使用 `somnolent-hogwash-2018-09-01/sh.rnnn`。模型版本、下载链接及 SHA256 记录在 `models/speech-denoise-source.json`，模型说明在 `models/speech-denoise-info.txt`。处理方式见 [FFmpeg arnndn 文档](https://ffmpeg.org/ffmpeg-filters.html#arnndn)。在项目根目录执行：

```powershell
ffmpeg -hide_banner -loglevel error -y -i 'C:\Users\12587\Downloads\10月8日 2.m4a' -af 'aformat=sample_rates=48000:channel_layouts=mono,highpass=f=65,arnndn=m=models/speech-denoise.rnnn:mix=1,aresample=24000' -c:a pcm_s16le 'public/assets/voice-reference-clean.wav'
ffmpeg -hide_banner -loglevel error -y -i 'public/assets/voice-reference-clean.wav' -c:a aac -b:a 128k -movflags +faststart 'public/assets/voice-reference-clean.m4a'
```

数值检查：原 PCM 参考时长 12.4587 秒，输出 12.4600 秒；没有剪掉开头或结尾。首秒平均能量从 -32.8 dBFS 降到 -53.8 dBFS，最后约 0.46 秒从 -33.3 降到 -51.0 dBFS。输出峰值为 -1.02 dBFS，无削波样本。低能量帧的下降不等同于所有语音片段的信噪比改善；降噪不能保证完全去除与主讲者重叠的人声。详细数值在 `output/audio-cleanup-metrics.json`。

这次完成的是原录音降噪、页面试听替换以及声音参考替换。没有创建新的自定义 voice ID；生成任意新句子使用此人的音色，仍需完成项目的专属音色接入。
