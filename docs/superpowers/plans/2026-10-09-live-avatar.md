# 实时写实数字人 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement inline, then request an independent code review.

**Goal:** 当前办公室照片在每轮实时语音对话中自然呈现口型和表情，固定使用用户复刻音色，支持同时打断声画，不显示字幕。

**Architecture:** 豆包继续生成 24 kHz PCM；有状态抗混叠重采样为 Simli 所需 16 kHz PCM。Simli 的 WebRTC 返回同一条音视频流，由一个 video 元素播放，杜绝原声提前播放或双重声音。后端保护长期 API Key，只把短期 session token 和 ICE 配置交给浏览器。

**Tech Stack:** Node.js / Windows DPAPI / native WebRTC / browser WebSocket / Playwright / node:test.

**Scope:** 实时流，不生成或循环播放预录视频。真实自然程度须在用户照片的人像模型就绪后实测；未配置时继续现有照片语音模式，不声称视频已接通。

- [x] Task 1: `simli-service.mjs`、`server.mjs`：DPAPI 保存 API Key 和确认的人像 ID；安全查询人像；生成短期令牌；不返回密钥或原始错误。先写并运行 `tests/simli.test.mjs`，验证保密、固定人像、缺失模型和服务失败。
- [x] Task 2: `public/pcm-resampler.js`：24→16 kHz 有状态 FIR 重采样。先写 `tests/pcm-resampler.test.mjs`，验证时长、分块一致性、低频音高、高频抗混叠。
- [x] Task 3: `public/simli-video.js`：真实 WebRTC 收流，单 video 声画播放、首帧就绪、SKIP 清缓冲、取消连接和资源释放。与 `public/doubao-conversation.js` 衔接，视频启用时不直放 PCM。
- [x] Task 4: `public/index.html` / `public/app.js` / `public/simli-video.css`：本机私有配置与状态；原照片保留，首个真实帧到达才切换；不添加对话文字。Playwright 在本机产生真实 RTC 测试流，验证输出音频只有一路、16 kHz 输入、插话与取消。
- [ ] Task 5: 官方协议来源和中文设置文档；独立审查；全量检查；重启本机服务。用户人像模型生成完后进行真实云端声画测试。

## Execution ledger

- 账号 API Key 已通过 GET /faces 验证：HTTP 200，暂无人像。密钥已使用 DPAPI 保存，未落地明文。
- Ruling: 不自动换用公开示例人像 — 用户要求照片里的本人。
- Ruling: 不添加字幕 — 用户要求只用声音；内容与口型对应由真实音频驱动。
- Ruling: 暂不自动购买或调用未知收费的人像训练 — 用户选择免费试用；先准备连接入口，控制台确认试用资源后创建可驱动模型。
- 官方来源：Simli compose/token、compose/ice、migration guide、SDK 3.0.2。P2P 路径采用迁移指南和发布 SDK 一致的 /compose/webrtc/p2p，非文档生成器的 peer_to_peer 路径。
- Ruling: SKIP 没有文档保证的确认，SILENT 也不是播放完成屏障 — 后续问题保守关闭旧接收流并创建新流；新增音频保持 FIFO；增加网络和会话开销，真实延迟待模型就绪后实测。
- 独立审查发现并修复：旧画面恢复、SILENT 截尾、生成完成乱序、握手 FIFO 越序、播放停顿误判、旧异步 play 错误影响新连接。审查复核无新的确凿 Important。
- 新增确定性回归先失败后通过。最后完整验证：60 项 Node / 19 项 Chrome 浏览器测试通过。测试声画为本机 RTC 流，未调用云端视频生成。
- 2026-10-09 再次读取官方 /faces：账号认证成功、人像数 0。报告 output/simli-account-check.json。仍需当前照片 Face ID；未完成真实写实视频验证。
- 2026-10-09 用户确认 Simli 控制台要求付费创建本人头像；未购买或上传照片。原免费试用选择继续有效，头像创建收费是当前真实视频接入的阻碍。
- 免费替代候选核查：Anam 官方价格页当前明确包含免费照片上传、自定义头像 1 个、API、每月 30 分钟和单次 3 分钟；官方文档支持外部实时音频 passthrough，可保留豆包复刻声音。未取得 Anam 账号、头像 ID 或凭据，未切换代码，不能声称新供应商已接通。参考 docs/simli-realtime.md。
