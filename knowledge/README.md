# 景区资料目录

当前只有真实景区「承德避暑山庄」，核对日期为2026年10月10日。目录服务于后续全国景区资料管理；当前应用没有向量索引、检索接口或每轮问答的 RAG。

`catalog.json` 给每个景区独立的 `id`、名称、别名、省市和文件路径，`defaultScenicId` 指定新安装的默认景区。当前编号为 `cn-hebei-chengde-bishushanzhuang`。以后添加独立景区目录与 catalog 条目，不把多个景区塞进同一份讲解资料。

每个景区包含：

- `profile.json`：当前实时语音会话使用的简短资料，有长度限制。
- `documents.json`：按历史、园林、景点、路线、游客服务整理的资料条目。记录景区编号、主题、事实或建议的类别、核对日期、来源编号和必要的有效期；目前供整理与未来索引使用，不参与在线检索。
- `sources.json`：官方网页的标题、发布机构、URL、核对日期和适用范围。内容为事实摘要，没有归档整篇网页。

默认资料来自[景区官网概况](https://www.bishushanzhuang.com.cn/index.php/About/ac_view/id/1.html)、[景区官方路线](https://www.bishushanzhuang.com.cn/index.php/Scenic/area_index.html)、各景点官方页面和[世界遗产中心](https://whc.unesco.org/en/list/703/)。具体对应关系见 `sourceIds`。路线为根据官方站点整理的简化建议，不能当作已核实的实时导航。资料不覆盖当天门票价格、临时关闭、天气或客流。

状态为 `expired` 的2026年夏季开放公告只保留作历史归档，有效期到2026年10月9日，不供当前讲解使用。`reference_only` 的咨询信息保留核对日期，不承诺持续实时有效。

运行时 `GuideStore` 仅在没有已保存资料时从 catalog 指定的 `profile.json` 加载默认内容。`.private/guide-scenes.json` 中已有的编辑优先，不会因修改 catalog 自动覆盖；本次按用户要求单独备份并替换了本机旧演示资料。景区目录不是网页静态资源，不能通过 `/knowledge/` 下载。

后续检索接入与全国景区扩展见[知识库规划](../docs/全国景区知识库规划.md)。
