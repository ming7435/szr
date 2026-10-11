# 本机实时口型 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, then request one fresh independent review.

**Goal:** 用现有复刻音色和当前照片进行实时口型对话，插话同时停止声音和嘴部画面。

**Architecture:** OpenVINO Python worker逐帧推理并返回配对原PCM/JPEG；Node仅限本机的WebSocket承载；浏览器AudioContext统一调度声音和嘴部画面。

**Tech Stack:** Windows, Python3.12, OpenVINO2024.6, NumPy/SciPy/OpenCV, Node/ws, Canvas/WebAudio, Playwright.

**Spec:** docs/superpowers/specs/2026-10-09-local-mouth-design.md

## Global Constraints

- 当前照片及固定复刻音色；无对话文字。
- 每次回答最多90秒；解码提前量最多2秒；一个本机人像连接。
- 个人和研究测试，Wav2Lip模型不能商业部署。
- 完整表情未实现，状态文案仅称实时口型。

## Review Focus

- 插话发生在推理或JPEG解码中：旧结果不得回到屏幕或扬声器。
- 少于219ms的短回答和末帧：可结束，原PCM不能丢失或改变。
- 音频分块边界：口型特征、音频时长不随分块变化。
- 浏览器缓冲或断线：限定内存，故障停音并恢复照片。
- 两个标签页及外部来源：不交叉播放，不允许外部网页调用本机模型。

## Tasks

- [x] Task1: `scripts/avatar_features.py` / `scripts/avatar-worker.py`。先写 `tests/avatar_stream_test.py`，与现有librosa参考比对特征，检验分块、尾帧和PCM逐字节相等；再实现滚动音频和25FPS推理，隔离`.runtime/avatar-env`和已校验模型。
- [x] Task2: `local-avatar-service.mjs` / `server.mjs`。先写 `tests/local-avatar.test.mjs`，检验失效代次、连接隔离、长度/来源限制及关闭释放；再实现worker桥接和配置。
- [x] Task3: `public/local-mouth.js` / `public/app.js` / `public/index.html` / CSS。先写 `tests/browser/local-mouth.spec.mjs`，检验实际AudioContext播放、异步迟到帧丢弃、停止/取消、下一轮隔离和字幕隐藏；再接现有Doubao renderer接口。
- [x] Task4: 新的实际本机口型+豆包声画验证，记录首个可听声音/可见口型延迟，保持已有麦克风/静音/打断验证。独立审查，完整Node/Chrome检查，更新中文文档并启动页面。

## Ledger

- Ruling: 在当前非Git工作区原地执行用户明确选择的接入；不要求再次批准同一范围，不创建工作树或提交。
- 模型和OpenVINO轮子已通过上游SHA256校验；诊断环境和生产环境分开，诊断视频不作为产品回答。
- Python参考特征、分块及短尾3项通过。首次分段STFT边界测试失败，修正为与Librosa参考一致的零填充后通过。
- 独立审查发现旧worker迟到退出影响新连接；回归先失败再修复实例隔离。浏览器测试图像、音频处理等待及WS注册竞态修正后实际Chrome通过。复查无剩余Important/Critical。
- 后续发现逐帧重新加入启动缓冲会产生小间断；新增真实WebAudio回归先失败，改为仅首次加缓冲、后续连续排播后通过。
- 最终完整验证65 Node / 23 Chrome / 3 Python通过。实际豆包+GPU+浏览器两次验证通过，首个声画回答约1.16s及1.22s，预热连接约1.44s；PCM逐字节保留、静音/声画停止/迟到帧隐藏/麦克风释放通过。最新记录output/local-mouth-live-verification.json。
- 照片SHA256仍为989B5D5D69E178900BB5726CE4A8B3948AA91FC2F8869D15CF5EE5FF63DDEEC3。完整表情与商业接待未实现，不能据本轮口型验收声称全目标已完成。
