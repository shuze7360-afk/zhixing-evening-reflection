# 知行（evening-reflection）

Windows 个人晚间复盘助手：每天用 3—5 分钟讲讲当天的取舍，AI 结合内置的《纳瓦尔宝典》原则卡帮你看清背后的道理，改进建议落成 ≤7 天的最小实验，结束后自动整理成日报/周报/月报/年报，并单向导出到 Obsidian。

**本地优先，隐私在架构里**：数据全部存在本机 SQLite；API Key 经 Windows safeStorage 加密；AI 请求只携带当天的复盘文本；导出单向（应用是事实源，手工修改不会回流，也绝不会被覆盖）。

```bash
npm install     # 依赖（.npmrc 已配置 npmmirror 镜像，可按需删除换官方源）
npm run dev     # 开发模式（构建 main/preload → Vite → Electron 窗口）
```

## 功能

- **对话式复盘**：流式对话 + 追问上限 + 跳过机制；"也许可以"永远不会自动变成已接受行动
- **反编造合同**：AI 的归纳/感受/行动候选一律先进"待核对"，只有你逐字说过的事实、你点过确认的条目才进入正式日报
- **思想库**：内置《纳瓦尔宝典》原则卡（含来源快照），启用后进入上下文；引用必须可溯源
- **最小实验**：三假设 → 选关键 → ≤7 天验证，观察与结论闭环
- **周期报告**：周/月/年报自动生成，长输入自动分批（≤24KiB），失败断点续跑，证据索引绑定到具体日报修订
- **Obsidian 单向导出**：修订另存 `.rN`、无覆盖原子发布、目标目录可绑定到任务
- **备份与恢复**：VACUUM 快照 + 凭据脱敏 + 字节级哨兵校验；恢复全程排他协议，绝不静默以空库启动
- **MCP 服务器**：13 个本地数据工具，可接入支持 MCP 的 AI 助手（零模型调用，密钥不出应用）

## 多模型兼容（OpenAI 兼容接口）

默认使用智谱 BigModel（`glm-5.3-flash`）。设置页「模型连接」可改为**任何 OpenAI 兼容接口**：

| 服务 | 接口地址（Base URL） | 模型名示例 |
|---|---|---|
| 智谱 BigModel（默认） | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flash` |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| Moonshot | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |

接口地址填到**版本根**，模型名填该服务的模型 ID，API Key 填所选服务签发的 Key（保存后 safeStorage 加密，不回显）。对话、日报提炼、周期报告、连接测试全部跟随该配置。

## 隐私与安全设计

- API Key 仅经 Windows safeStorage 加密存于本机数据库，永不写入明文/日志/导出文件，永不随代码分发
- 备份文件自动脱敏（删除凭据行 + 重整页 + 字节级哨兵校验），恢复后需重新输入 Key
- 默认导出目录从当前用户主目录推导（`Documents/Obsidian Vault/个人成长/晚间复盘`），可在设置修改
- 无遥测、无账号体系；唯一的网络请求是你配置的模型接口
- 预算闸门：月度预算 + 输入/输出分价预占，超预算自动暂停所有模型调用

## 开发

```bash
npm install
npm run dev            # 开发模式
npm run typecheck      # 主进程 + 渲染进程类型检查
npm run build:main     # 构建 main/preload
npm run build:renderer # 构建渲染层
npm test               # 全量回归（十三套 99 项：正常路径 + 故障注入反例）
npm run dist           # NSIS 安装包（x64）
```

技术栈：Electron 44（`node:sqlite` 内置模块）· React 19 · TypeScript · Vite · Tailwind 4。

### 测试

`tests/` 下十三套 99 项，风格是**故障注入反例**：SQLite 触发器精确打击某一步（路径落库、状态提交、running 更新…）、双进程并发屏障、真实 IPC 处理函数 + Electron 替身、跨午夜时钟场景。每项都对应一次独立审阅发现的缺陷，"修复前失败 / 修复后通过"。其中 3 项交接检查器回归依赖未随仓库分发的内部流程文件，会自动跳过。

### 项目结构

```
src/main        主进程（会话/日报/周期报告/预算/备份恢复/Obsidian 导出/设置）
src/preload     contextBridge 白名单 API
src/renderer    React 七页面
src/shared      类型 + zod schema + 常量
mcp/            MCP 服务器（源码 + 构建产物 server.mjs）
resources/      提示词（版本化）+ 原则卡快照 + 图标
docs/           产品/架构/UI/验收/决策/参考/使用说明/MCP
tests/          十三套回归（含故障注入反例）
scripts/        构建/开发/交接检查脚本
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | 产品要求：复盘流程、思想库、实验、报告 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 技术栈、进程模型、模型调用、预算、可靠性 |
| [docs/USAGE.md](docs/USAGE.md) | 使用说明（含多模型配置） |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 关键决策记录（D-001 起） |
| [docs/MCP.md](docs/MCP.md) | MCP 服务器接入说明 |

## 说明

- 模型价格为用户可改的本地估算（默认占位价并标注"未核实"），不代管任何云账户账单
- 原则卡摘录自公开流通的《纳瓦尔宝典》（The Almanack of Naval Ravikant），仅短摘录 + 章节链接 + 快照用于个人研究
- 未附带开源许可证：保留所有权利；如需以特定许可证使用/分发，请开 issue 联系
- 本仓库未包含项目内部的流程管理材料（状态源、审阅证据等）
