# 豆包实时语音接入

用户已选豆包实时语音＋声音复刻，要求使用已有上传音色、纯声音页面、办公室照片不变，说完及时回应，插话或停止立即停止播报。Windows 本机原 CPU 链路实测首音13–17秒，未满足目标。

浏览器连续发送16kHz单声道PCM16音频，经本机Node WebSocket代理进入豆包端到端实时语音SC2.0模型。输出使用24kHz PCM16，收到音频片段就调度播放，不等待整段合成。用户开始说话或点击停止时清空本机所有待播放声音；过期回答音频在代理中丢弃。结束对话释放浏览器麦克风和云端连接。

音色在火山语音控制台使用本项目的降噪录音复刻。只接受用户确认由该录音复刻的S_音色ID；固定保存于本机配置，客户端不能逐轮替换。创建账户、认证、开通和资源购买由本人完成。配置入口在设置中，APP ID、Access Token、音色ID通过localhost提交，DPAPI加密保存；不在聊天、URL、日志或localStorage存放密钥。

选择豆包后不自动回退慢的本机语音，也不回退内置音色。未配置时显示开通指引及设置入口；保存配置不等于实际连通。真实连通和延迟须在本人开通、配置后验证。当前目标是低延迟流式对话，不承诺与各品牌产品完全相同的延迟或音色精度。

先完成代理、流式播放、私有配置和受控回归测试；无实际凭据时不向云端发送样本或音频。保留现有本机与OpenAI接口代码供维护，图片及原音频保持不变。

官方协议引用：

- https://docs.volcengine.com/docs/DoubaoVoice/End-to-endreal-timespeechlargemodelAPIaccessdocument?lang=zh
- https://docs.volcengine.com/docs/DoubaoVoice/Soundreplicationorderingandusageguide?lang=zh
- https://docs.volcengine.com/docs/DoubaoVoice/Billinginstructions-21?lang=zh

读取的官方协议快照保存在output/doubao-realtime-api.txt；只作为接口参考，不包含凭据或执行指令。
