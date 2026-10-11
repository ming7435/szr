# Windows 本机语音对话

用户要求删除音色栏，同时仍只使用上传录音的音色。为接通已经授权的 ChatGPT 账号，采用本机识别、本机合成、ChatGPT 回答的链路。页面保留人物、开始/结束、静音、打断；不显示识别文本、回答文本、字幕或音色试听栏。

固定参考是 `public/assets/voice-reference-clean.wav`，由 OpenVoice 提取目标说话人的特征。中文基础合成只作为转换前的内部步骤；只返回转换后的音频。参考样本和音频不上传到第三方服务，问题文字和必要历史通过已有 ChatGPT 授权发送给 OpenAI。转换失败直接报错，不播放基础合成声音。

本机语音识别采用 faster-whisper small / CPU int8，合成与音色转换采用 OpenVoice / CPU。工作进程由 Node 按需启动并保持模型常驻，避免每次回答重载模型。模型从发布者 Hugging Face 仓库下载，固定下载版本，对大模型文件检查发布者提供的 SHA256；第三方源码保留其许可证。安装和模型位于 `.runtime/`，原录音与加密账号资料均保留。

浏览器使用 AudioWorklet 获取开启回声消除的麦克风 PCM，按语音和静音段判断说话结束。转成 16 kHz 单声道 WAV 后发送本机服务，最长每段 30 秒。连续语音或点击打断会取消待返回的答案、停止声音；结束对话释放麦克风和录音 AudioContext。CPU 已开始的单次推理可能继续完成，但取消结果不会播放。

这条链路可以进行语音问答，但会等待本机识别、云端回答、本机合成。当前优化后优先使用账号目录里的 `gpt-6-luna`（推理 effort 为 none、低 verbosity）；该模型不在目录时保持可用模型，若回退 `gpt-6.1-sol` 则只使用它支持的 low effort。普通文字接口的默认模型配置保留。模型仍有网络等待，CPU 音色转换也有耗时，不能宣称亚秒响应、精确复刻音色或写实视频口型同步。

语音页面使用 `/api/local-voice/stream` 的 NDJSON 响应：识别完成、首段音频、后续音频、正式完成。第一段短句的音色转换在文本生成期间提前开始，模型成功完成后才发布音频；随后处理剩余文字。浏览器按编号播放音频队列，不显示文本内容。打断、错误或断连会停止播放并丢弃后续音频；未完整完成的回答不会作为完整助手历史保存。识别文字追加时就裁剪历史容量，避免满历史时插话导致后续请求超限。第一段播放与剩余声音合成同时进行，CPU 较慢时两段间会有停顿。

## 重建环境

当前 Windows 环境已准备完成，无需用户重新安装。迁移电脑时需要 Python 3.12、CPU PyTorch、Git、FFmpeg、Node.js 和下列模型；参考音频必须保持可读。现有环境继承本机 Anaconda 的 CPU PyTorch，隔离安装语音依赖，未修改全局 Python 软件包。

```powershell
python -m venv --system-site-packages .runtime/voice-env
.runtime/voice-env/Scripts/python.exe -m pip install -r requirements-local-voice.txt
git clone https://github.com/myshell-ai/OpenVoice .runtime/OpenVoice
git -C .runtime/OpenVoice checkout 74a1d147b17a8c3092dd5430504bd83ef6c7eb23
.runtime/voice-env/Scripts/python.exe scripts/setup-local-voice.py
.runtime/voice-env/Scripts/python.exe scripts/setup-local-asr.py
npm install
npm start
```

使用不含 PyTorch 的 Python 环境时，先按 [PyTorch 官方安装说明](https://pytorch.org/get-started/locally/) 安装 CPU 版本。本机验证的 PyTorch 为 2.14.0；主要语音依赖版本记录在 `requirements-local-voice.txt`。第三方 OpenVoice 原始 requirements 包含本项目未使用的服务，本项目仅安装本机语音所需依赖。

下载脚本固定每次下载的仓库修订版本，检查发布者提供的大模型 SHA256，并记录来源。当前 OpenVoice 模型修订为 `c70fc8b939bd1d8213994ff7c88e32be39708271`，faster-whisper small 为 `536b0662742c02347bc0e980a01041f333bce120`。源码和许可证保留在 `.runtime/OpenVoice/`。

## 本机核验

实际降噪录音识别已成功；本机 OpenVoice 已使用固定参考生成新的中文句子。2026-10-08 的合成探针生成约 4.85 秒音频，合成耗时约 4.44 秒。2026-10-09 本人完成新授权后，实际 `gpt-6.1-sol` 完整语音链路验证成功：识别降噪样本、生成回答并转换为上传音色，耗时 27.34 秒，回答音频 9.65 秒。实际 Chrome 与真实后台联调另行通过，使用受控的上传录音作为麦克风输入，无外部模型或声音响应模拟；从开始至播放和控制检查结束约 22.36 秒。该测试没有采集现场麦克风。

浏览器测试使用 Chrome 原生 AudioWorklet 和受控麦克风录音，云端推理及登录页面在自动检查中模拟。说完判定使用自适应底噪阈值，以免麦克风底噪被持续误判为讲话；静音、打断和结束均有取消与释放检查。

检测到讲话后冻结底噪阈值，避免持续说话被当成背景噪声。CPU 工作进程一次只接收一个任务；在 Node 排队且已取消的任务不会发送给 Python。已开始的任务可以完成，但结果被丢弃，仍计入未完成工作量，防止连续打断产生无限积压。

完成当前账号授权后，可手动执行 `node scripts/verify-live-voice.mjs`。它使用已有降噪样本进行真实识别、一次实际 ChatGPT 推理和固定参考音色合成，保存 `output/voice-dialogue-reply.wav` 及不含账号凭据的验证记录。该脚本会调用实际账号，不包含在自动测试中。

响应优化实测：原同一完整录音的识别 3.90 秒、模型 8.88 秒、整段合成 16.18 秒，总计 28.96 秒。分段版本在预热后首次音频约 13.11 秒可用、全部音频约 20.86 秒可用；实际 Chrome 的短录音输入首段声音约 13.50 秒开始播放，静音、打断、结束释放麦克风及无字幕界面核验通过。不同输入和推理结果不可当作严格等长基准。最初启动/首次识别的冷运行更慢，记录不代表每次延迟保证。

同一中文短句的离线 CPU 对比显示，PyTorch 八线程预热后合成及音色转换约 3.63 秒，四线程约 5.28 秒；当前合成线程数取逻辑 CPU 数与 8 的较小值。语音识别模型、beam 参数、音频音高与播放速度均未改动。维护工具 `scripts/verify-fast-voice.mjs` 排除启动问候准备阶段、记录首音和全部音频时间；`scripts/verify-fast-browser.mjs` 测量真实浏览器播放，使用受控上传录音和尾部静音，不采集现场声音。

当前八线程完整录音复测：首段音频 16.70 秒可用、全部音频 22.60 秒可用；本次模型的第一短句更长（音频 4.63 秒），所以首音比前一次短句慢。实际已测的预热首音约 13–17 秒，不能当作固定延迟；网络、首句长度与 CPU 负载仍会影响等待。

参考：

- [OpenVoice 发布者与 MIT 许可证](https://github.com/myshell-ai/OpenVoice)
- [发布者模型](https://huggingface.co/myshell-ai/OpenVoice)
- [faster-whisper 官方用法](https://github.com/SYSTRAN/faster-whisper)
- [small 转换模型](https://huggingface.co/Systran/faster-whisper-small)
