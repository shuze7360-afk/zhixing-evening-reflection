// 受控 Git 基线助手（第六轮审阅 §4"测试归因"整改）：
// 副本排除 .git 复制 → 全新提交 → 副本内真实重冻结候选 → 按检查 13 同一规则重建整树清单
// → 重新渲染。产出一个"完整正常基线"，使后续反例断言能精确归因（✗ 13 而非任意失败）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export function buildBaseline(dst) {
  execFileSync('git', ['init', '-q'], { cwd: dst });
  execFileSync('git', ['add', '-A'], { cwd: dst });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base'], { cwd: dst });
  // 副本内容与源仓库候选/整树登记无关（整改已改变内容）——副本内真实重冻结
  execFileSync(process.execPath, [join(dst, 'scripts/freeze-candidate.mjs'), 'ER-R01'], { cwd: dst, stdio: 'pipe' });
  // 按检查 13 完全一致的规则重建整树清单
  const excl = (p) => ['project-state.json', 'CURRENT_STATE.md', 'HANDOFF.md'].includes(p)
    || /tasks\/[\w-]+\/evidence\//.test(p) || /tasks\/[\w-]+\/review\.md$/.test(p);
  const agg = createHash('sha256');
  const entries = [];
  for (const rel of execFileSync('git', ['ls-files'], { cwd: dst, encoding: 'utf8' }).split('\n').filter(Boolean).filter((p) => !excl(p)).sort()) {
    const buf = readFileSync(join(dst, rel));
    const h = createHash('sha256').update(buf).digest('hex');
    entries.push({ path: rel, bytes: buf.length, sha256: h });
    agg.update(rel + '\n' + buf.length + '\n' + h + '\n');
  }
  const hash = 'sha256:' + agg.digest('hex');
  const manifest = 'tasks/ER-R01/evidence/whole-tree-test.json';
  writeFileSync(join(dst, manifest), JSON.stringify({ hash, algorithm: 'test baseline', file_count: entries.length, files: entries }, null, 2));
  const st = JSON.parse(readFileSync(join(dst, 'project-state.json'), 'utf8'));
  st.worktree_whole = { candidate: hash, manifest, file_count: entries.length, frozen_at: new Date().toISOString(), acceptance: 'test baseline' };
  writeFileSync(join(dst, 'project-state.json'), JSON.stringify(st, null, 2));
  execFileSync(process.execPath, [join(dst, 'scripts/render-state.mjs')], { cwd: dst, stdio: 'pipe' });
  return { wholeTreeHash: hash, manifest };
}

export function runCheck(dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'scripts/handoff-check.mjs')], { encoding: 'utf8', cwd: dir });
    return { code: 0, output: out };
  } catch (e) {
    return { code: e.status, output: (e.stdout ?? '') + String(e) };
  }
}
