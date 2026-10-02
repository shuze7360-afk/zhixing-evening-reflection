# docs/MCP.md — 知行 MCP 服务器

> 把「知行」的本地复盘数据封装为 Model Context Protocol（stdio）服务器，让 ZCode / Claude / Cursor 等 AI 助手直接读写本地数据。安全边界见 `docs/DECISIONS.md` D-019：**只做本地数据，不携带 API Key、不触发模型调用、零费用**。

## 工具清单（13 个）

| 工具 | 说明 | 写/读 |
|---|---|---|
| `today_snapshot` | 今天的会话、消息、日报与导出状态 | 读 |
| `add_quick_note` | 只记一句：本地生成正式日报并导出 Obsidian（不发起 AI 反馈） | 写 |
| `get_report` | 按日期查询日报全部修订（缺省今天） | 读 |
| `list_reports` | 列出近期日报与导出状态 | 读 |
| `export_report` | （重新）导出某日最新日报，幂等 | 写（本地文件） |
| `list_principles` | 原则卡（原文/解读/边界/启用状态） | 读 |
| `add_principle_draft` | 新增原则卡**草稿**（默认未启用） | 写 |
| `list_experiments` | 实验列表 + 当前进行中 | 读 |
| `create_experiment` | 创建 ≤7 天最小实验（三假设选关键；单进行中约束强制） | 写 |
| `add_observation` | 记录实验观察 | 写 |
| `conclude_experiment` | 结束实验并登记结论 | 写 |
| `list_period_reports` | 周/月/年报（含过时标记与证据索引） | 读 |
| `get_budget_status` | 本月费用占用/上限、Key 是否配置（无密钥内容） | 读 |

**刻意不做**：启用原则卡（确认门只在应用界面）、触发任何 BigModel 调用、读取/导出 API Key。

## 注册到 ZCode

- **本项目（工作区级，已配置）**：`.zcode/config.json` 已含 `mcp.servers.zhixing`，在本项目打开 ZCode 即自动连接。服务器以仓库根为工作目录解析 `mcp/server.mjs`；若你的客户端不从仓库根启动命令，把 `args` 改为绝对路径。
- **个人全局（用户级）**：`~/.zcode/cli/config.json` 的 `mcp.servers` 中加入同一对象（建议 `args` 用绝对路径）。

```json
{
  "mcp": {
    "servers": {
      "zhixing": {
        "command": "node",
        "args": ["mcp/server.mjs"]
      }
    }
  }
}
```

## 注册到其他客户端

- **Claude Desktop / Cursor（stdio）**：`command: node`，`args: ["<仓库绝对路径>/mcp/server.mjs"]`。
- 环境变量：
  - `ZHIXING_DB_PATH`：显式指定数据库文件（缺省自动探测 `%APPDATA%\知行\zhixing.db`，回退 `%APPDATA%\evening-reflection\zhixing.db`）；
  - `ZHIXING_OBSIDIAN_DIR`：覆盖 Obsidian 导出目录（测试/隔离用，避免写入真实 Vault）。
- 与常驻应用并发：SQLite WAL + busy_timeout（5s），应用与 MCP 可同时打开同一数据库。

## 构建与测试

```bash
npm run mcp:build        # esbuild 打包为自包含 mcp/server.mjs（约 1.4 MB，Node ≥20 直接运行）
node --test tests/mcp-smoke.mjs   # 协议级冒烟：握手/工具清单/调用/约束（临时库，不触碰真实数据）
```

`mcp/server.mjs` 为提交到仓库的构建产物（改 `mcp/src/server.ts` 后需重新构建）。
