# src/preload — 预加载脚本

职责（ER-001 起实现）：通过 contextBridge 向渲染进程暴露**限定 IPC 白名单**；开启上下文隔离，渲染进程无 Node 集成。

规则见 docs/ARCHITECTURE.md §2。
