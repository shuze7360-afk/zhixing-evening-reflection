// 冻结候选版本：对任务声明的交付范围计算内容哈希，写入证据清单与状态源，并自动重新渲染生成文件。
// 用法：npm run candidate:freeze -- ER-000
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadState, saveState, collectScope, hashCandidate, sha256Hex, gitInfo } from './lib.mjs';

const taskId = process.argv[2];
if (!taskId) {
  console.error('用法: npm run candidate:freeze -- ER-000');
  process.exit(2);
}

const state = loadState();
const task = state.tasks.find((t) => t.id === taskId);
if (!task) {
  console.error(`未找到任务 ${taskId}（应在 project-state.json 的 tasks 中）`);
  process.exit(2);
}
if (!Array.isArray(task.candidate_scope) || task.candidate_scope.length === 0) {
  console.error(`任务 ${taskId} 未声明 candidate_scope（交付范围应在 project-state.json 中定义）`);
  process.exit(2);
}

const entries = collectScope(task.candidate_scope);
if (entries.length === 0) {
  console.error('交付范围为空，拒绝冻结');
  process.exit(2);
}

const hash = hashCandidate(entries);
const seq = state.candidates.filter((c) => c.task === taskId).length + 1;
const id = `${taskId}-cand-${seq}`;
const now = new Date().toISOString();
const git = gitInfo();
const manifestRel = `tasks/${taskId}/evidence/candidate-${hash.slice(7, 19)}.json`;

const manifest = {
  candidate_id: id,
  task: taskId,
  hash,
  algorithm: 'sha256 over sorted(rel\\n byteLen\\n fileSha256\\n)',
  frozen_at: now,
  git_head: git.head,
  worktree_dirty_at_freeze: git.dirty,
  file_count: entries.length,
  files: entries.map((e) => {
    const buf = readFileSync(e.abs);
    return { path: e.rel, bytes: buf.length, sha256: sha256Hex(buf) };
  }),
};

mkdirSync(join(ROOT, 'tasks', taskId, 'evidence'), { recursive: true });
writeFileSync(join(ROOT, manifestRel), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

task.candidate = { id, hash, frozen_at: now, manifest: manifestRel };
// S8：内容变化 → 旧审阅自动失效（阶段回落，审阅状态清空；handoff-check 09 强制重新审阅）
if (task.review && (task.review.status === 'passed' || task.stage === 'reviewed' || task.stage === 'completed')) {
  task.stage = task.stage === 'completed' ? 'review_pending' : 'review_pending';
  task.review = { status: 'pending', reviewer: task.review.reviewer ?? null, reviewed_candidate: null };
  console.log('[freeze] 旧审阅已自动失效（候选内容变化）：' + taskId);
}
state.candidates.push({
  task: taskId, id, hash, manifest: manifestRel,
  file_count: entries.length, frozen_at: now, git_head: git.head,
});
saveState(state);

execFileSync(process.execPath, [join(ROOT, 'scripts', 'render-state.mjs')], { stdio: 'inherit' });

console.log(`候选已冻结：${id} ${hash}`);
console.log(`文件数 ${entries.length} · 清单 ${manifestRel}`);
console.log('请运行 npm run handoff:check 确认一致性。');
