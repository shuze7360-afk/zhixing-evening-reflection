# src/main — 主进程

职责（ER-002 起实现）：SQLite 数据库、BigModel 模型调用、提醒与后台任务、Obsidian 文件导出。

安全边界见 docs/ARCHITECTURE.md §2：不向渲染进程开放任意命令执行或任意文件读写接口。
