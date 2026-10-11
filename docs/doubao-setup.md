# 用自己的音色开通豆包实时对话

页面入口：[本机数字人](http://127.0.0.1:4173/) →「分身设置」。头像保持当前办公室照片，主页面只进行语音对话。

## 1. 开通两个服务

打开[火山引擎语音控制台](https://console.volcengine.com/speech/new/overview?projectName=default)，用本人账号登录，完成控制台要求的实名认证。

在「开通管理」中分别开通：

- 豆包端到端实时语音大模型。
- 声音复刻 2.0。

先检查试用额度和音色资源。若需要购买复刻音色名额，由你在控制台核对价格后购买。2026-10-09 查到的官方小批量音色名额单价为 138 元/音色，实时对话用量另计，最终以账户控制台为准。

官方资料：[购买和使用指引](https://docs.volcengine.com/docs/DoubaoVoice/Soundreplicationorderingandusageguide?lang=zh)、[计费说明](https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21?lang=zh)。

## 2. 用自己的录音创建音色

在本机数字人「分身设置」中点击「下载降噪录音」，或者使用项目文件 `public/assets/voice-reference-clean.wav`。这是此前上传声音的降噪版本，约 12.46 秒，不需要重新录制才能开始尝试。

在控制台找到声音复刻 2.0 的音色管理/训练入口，把这份 WAV 作为样本上传，选择录音对应的语言，按页面要求完成训练。如果服务提示样本质量或内容不合格，再补充自己的清晰录音。

等待音色状态显示训练完成，记下 **S_ 开头的音色 ID**。如果控制台试听效果不符合你的声音，先调整样本并重新训练，再接入。数字人会用该音色读出新回答，回答长度由对话内容决定。

## 3. 创建 API Key 并在本机填写配置

你截图使用新版控制台。点击左侧「API Key」，或打开[API Key 管理](https://console.volcengine.com/speech/new/setting/apikeys?projectName=default)，创建所选项目的 API Key。确认同一个项目具备实时语音及上述复刻音色的使用权限。

返回本机网页 →「分身设置」，填写：

1. 接入方式保持「新版控制台 · API Key」。
2. API Key，填入密码框。
3. 已训练完成的 S_ 音色 ID。

勾选「此音色由我上传的录音复刻，已完成声音复刻 2.0 训练」，点击「保存豆包配置」。不要把凭据发到聊天里。本机用 Windows CurrentUser DPAPI 加密保存，浏览器不保存密钥，配置接口不返回密钥。

兼容已使用旧版应用的账户：在[应用控制台](https://console.volcengine.com/speech/app)取得 APP ID 和 Access Token，本机选择「旧版应用」填写这两项。官方[API Key 使用说明](https://docs.volcengine.com/docs/DoubaoVoice/APIKeyUsage?lang=zh)指出，新版以 `X-Api-Key` 请求头鉴权，不需要 APP ID。

## 4. 开始真实对话验证

关闭设置，点击「开始对话」，允许麦克风，等到页面显示「语音对话已连接」再说话。可以插话，或点击方形按钮立即停止本机播放；麦克风按钮用于静音，「结束对话」释放麦克风及连接。

音频边生成边播放；本机停止时丢弃当前回答的剩余音频并请求截断上下文。连续收音模式下，下一次发言由服务判断并开始新回应；手动停止播放不承诺立即终止云端的所有生成和计费。

当前接入 SC 2.0（`2.2.0.0`），固定使用设置中的复刻音色。输入为 16 kHz PCM，输出为 24 kHz PCM。切换到豆包后，不会在缺少配置或失败时自动换成系统声音或原本较慢的本机语音链路。

麦克风音频和角色设定会发送到火山引擎，服务按账户额度和计费方式使用。2026-10-09 两项服务已开通，本机已配置用户提供的凭据和复刻音色 ID，并通过实际云端问答和 Chrome 播放验证。测试使用上传录音的 3.5 秒片段模拟麦克风，服务确认说话结束到有声播放约 0.78 秒，静音、手动停止播放及释放麦克风通过；这不是所有网络和回答的延迟保证，音色相似度由用户试听确认。证据为 `output/doubao-live-verification.json`，没有采集现场麦克风。上传样本创建云端音色由你在控制台完成，本应用不会替你购买或覆盖训练音色。

故障排查：权限或额度错误先检查两个服务是否开通、应用凭据和音色是否对应、声音是否训练完成；连接超时检查网络。页面保存成功只表示本机保存了配置，不表示云端授权有效。

实时接口依据：[官方 API 接入文档](https://docs.volcengine.com/docs/DoubaoVoice/End-to-endreal-timespeechlargemodelAPIaccessdocument?lang=zh)。
