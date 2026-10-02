# docs/REFERENCES.md — 参考来源与本地环境事实

> 引用外部材料时记录验证状态；未验证的明确标注"未验证"，不假称已核对。

## R-1 《纳瓦尔宝典》公开英文版

- URL：<https://www.navalmanack.com/almanack-of-naval-ravikant>（Eric Jorgenson 官方站点）
- 用途：思想库首批原则来源，覆盖时间取舍、专长、长期关系、判断产出。
- 验证状态：2026-10-01 本会话联网确认可达，确认为《纳瓦尔宝典》官方公开阅读页。
- 版权注意：网站公开连载，但仍为受版权保护的商业出版物。原则卡只保存英文短摘录 + 来源快照 + 章节链接，不复制整章内容。

## R-2 AIHOT（UI 风格参考）

- 仓库：<https://github.com/KKKKhazix/AIHOT>
- 参考提交：`cf8f8d07d68dfa9079becc72b0717a45b33485f3`
- 用途：浅/深色视觉风格、左侧导航与卡片布局基准（见 `UI_SPEC.md`）。
- 验证状态：**已验证**（2026-10-01，ER-001 开工会话）——`git fetch --depth 1` 成功抓取该提交（GitHub 网页访问仍超时，git 协议可达）；提交信息 "fix: pin patched fflate for image dependencies (#30)"，2026-09-30，含全树（含 apps/web/app/app.css 534 行设计令牌）。其令牌与 `UI_SPEC.md` 色板一致：浅底 `#faf9f6`、正文墨色 `#202a30`、青绿 `#176b75`、深底 `#13191c`、深色强调 `#12ccd8`（brand-cyan-54）、深色侧栏 `#161e21`、卡片圆角 12px（--radius-card）、细边框无渐变。ER-001 按此基准实现本项目自己的组件，不复制其代码。
- 复用纪律：使用本项目自己的名称与图标；复用代码保留原许可声明。

## R-3 BigModel 开放平台文档

- 开发者入口：<https://open.bigmodel.cn/dev/>；API 参考：<https://open.bigmodel.cn/dev/api>（2026-10-01 经检索确认的一般入口；具体接口页以官方文档为准）
- 端点、鉴权与模型配置见 `DECISIONS.md` D-001。

## R-4 本地环境事实（2026-10-01 实测）

- Node.js v24.15.0、npm 11.12.1、git 2.54.0.windows.1（Git Bash）。
- Obsidian：Vault 默认位于 `<你的用户目录>\Documents\Obsidian Vault`；默认导出子目录 `个人成长\晚间复盘` 不存在时由应用首次导出自动创建。
- 网络注意：2026-10-01 复测——GitHub git 协议（clone/fetch）可达；GitHub 网页直连超时。下载依赖与 Electron 二进制优先走 npm 镜像（项目 `.npmrc`：registry 与 ELECTRON_MIRROR 指向 npmmirror），失败再回退官方源并记录。
