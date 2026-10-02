// 渲染库（S8）：CURRENT_STATE/HANDOFF 的唯一模板。渲染脚本写文件；交接检查用同一函数生成预期全文比对。
// banner 是确定性的（状态源哈希 + 状态源时间），全文比较因此可行。
import { stateHash } from './lib.mjs';

export function buildGenerated(state) {
  const hash = stateHash(state);
  const banner = `<!-- 由 scripts/render-state.mjs 自动生成 · 状态源哈希 state:${hash} · 状态源更新 ${state.updated_at} · 禁止手工编辑，状态源变化后运行 npm run state:render -->`;
  const active = state.tasks.find((t) => t.id === state.active_task);
  
  const rows = state.tasks
    .map((t) => `| ${t.id} | ${t.title} | ${t.stage} | ${t.run_state} | ${t.candidate ? t.candidate.id : '—'} | ${t.review && t.review.status ? t.review.status : '—'} |`)
    .join('\n');
  
  const candidates = (state.candidates || [])
    .map((c) => `- ${c.id}（${c.task}）· \`${c.hash}\` · 冻结于 ${c.frozen_at} · 文件数 ${c.file_count} · 清单 \`${c.manifest}\``)
    .join('\n') || '（无）';
  
  const blockers = (state.blockers || []).length
    ? state.blockers.map((b) => `- ${b}`).join('\n')
    : '（无）';
  
  const current = `${banner}
  
  # CURRENT_STATE — 当前状态（自动生成）
  
  > 本文件由 \`npm run state:render\` 从 **project-state.json**（唯一状态源）生成。手工修改会在交接检查中判定失效。
  
  ## 项目
  
  - 代号：${state.project.codename}（evening-reflection）— ${state.project.description}
  - 状态源更新：${state.updated_at}（由 ${state.updated_by}）
  
  ## 角色分工
  
  - 源码写入者：${state.roles.source_writer}
  - 框架建立（计划 / 实际）：${state.roles.framework_builder.planned} / ${state.roles.framework_builder.actual}
  - 独立复核：${state.roles.independent_reviewer}
  
  ## 活动任务
  
  - **${state.active_task}** — ${active ? active.title : '（未找到对应任务，交接检查将失败）'}
  - 阶段：${active ? active.stage : '?'} · 运行状态：${active ? active.run_state : '?'}
  
  ## 任务总览
  
  | 任务 | 标题 | 阶段 | 运行状态 | 候选 | 审阅 |
  |---|---|---|---|---|---|
  ${rows}
  
  ## 候选版本
  
  ${candidates}
  
  ## Git 工作区
  
  实时 Git 状态由 \`npm run handoff:check\` 只读输出，不写入本文件（T6：生成内容只含稳定状态输入）。
  
  ## 预算
  
  - 月度默认：${state.budget.monthly_default_cny} 元（机制见 docs/DECISIONS.md D-012）
  - 备注：${state.budget.note}
  
  ## 阻塞
  
  ${blockers}
  
  ## 下一动作
  
  ${state.next_action}
  `;
  
  const handoff = `${banner}
  
  # HANDOFF — 交接说明（自动生成）
  
  > 静态恢复步骤以 **AGENTS.md** 为准；本文件动态部分来自 project-state.json。
  
  ## 恢复步骤（新会话必做）
  
  1. 依序阅读：AGENTS.md → project-state.json → CURRENT_STATE.md → 本文件 → 活动任务材料（tasks/${state.active_task}/ 下 plan.md、result.md、review.md、evidence/）。
  2. 核对 Git 工作区：\`git status\` 与 \`git log --oneline -5\`。
  3. 运行交接检查：\`npm run handoff:check\`，全部通过后才开始工作。
  
  ## 当前状态摘要
  
  - 活动任务：**${state.active_task}**（${active ? active.title : '?'}）
  - 阶段：${active ? active.stage : '?'} · 运行状态：${active ? active.run_state : '?'}
  - 候选：${active && active.candidate ? `${active.candidate.id} \`${active.candidate.hash}\`` : '未冻结'}
  - 审阅：${active && active.review && active.review.status ? active.review.status : '未登记'}
  ## 下一项具体工作
  
  ${state.next_action}
  
  ## 收尾要求（每轮结束）
  
  1. 更新 tasks/${state.active_task}/result.md 与 evidence/；
  2. 更新 project-state.json（阶段、下一动作、阻塞）；
  3. 交付内容变化时：\`npm run candidate:freeze -- ${state.active_task}\`；
  4. \`npm run state:render\` → \`npm run handoff:check\` → Git 提交。
  `;
  
  
  return { hash, current, handoff };
}
