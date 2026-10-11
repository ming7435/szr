# Pro 本地对话接入

目标：在现有 Windows 本机数字人网页中，通过用户自己的 ChatGPT 登录授权，使用其可用套餐额度完成连续问答。当前主页面只显示语音交互：本机识别问题，ChatGPT 进行文字推理，本机使用上传音色合成回答；详见 `local-voice.md`。人物图片保持不变。

实现：本机 Node 服务负责 OAuth 动态注册、PKCE、随机 state/nonce、回环回调、OIDC 签名验证、令牌更新和 Responses 流。浏览器仅取得登录链接、脱敏连接状态、可用模型和回答内容。登录资料保存在 `.private/chatgpt/`，由 Windows DPAPI CurrentUser 加密。不会读取 Codex 的登录文件。

验证：先验证未登录与流式问答接口，再覆盖回调 state、身份验证、加密保存、刷新轮换和中途失败；浏览器验证连续对话、取消回答、错误恢复与登录状态。实际连通必须以本人完成登录授权后收到 OpenAI 的完整回答为准。

账号连接位于「分身设置」。未授权时点击「开始对话」会打开官方登录页；授权后应返回本机回调，等待显示「登录已完成」，再返回语音界面。仅在 ChatGPT 网站登录账号并不代表已授权本应用。

损坏资料恢复：`publicSession()` 不暴露令牌，只报告读取错误。本人明确开始重新登录时，将不可读的 `connection.json` 保留为 `connection.unreadable.<随机标识>.json`，再执行新授权。新资料先写临时文件并刷盘，再原子替换；成功登录后继续执行身份和完整问答校验。

参考：
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations

官方 DevKit 仅提供非商业许可，本项目不引入或复制它的实现。此处独立实现公开 OAuth/OIDC 协议；本地测试的可用性以账号实际授权为准。未来对外企业部署需使用相应获准接入方式。
