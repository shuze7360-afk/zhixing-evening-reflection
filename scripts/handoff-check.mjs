// 交接一致性检查：验证状态源、任务文件、阶段、证据、候选哈希、审阅绑定、
// 生成文件新鲜度、Git 工作区与密钥安全。全部通过退出码 0，任何失败退出码 1。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildGenerated } from './render-lib.mjs';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, loadState, stateHash, collectScope, hashCandidate, gitInfo, readTextIfExists } from './lib.mjs';

const checks = [];
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail || '' });
  } catch (err) {
    checks.push({ name, ok: false, detail: err.message });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const STAGES = ['planned', 'implementing', 'self_checked', 'review_pending', 'reviewed', 'completed'];
const RUN_STATES = ['not_started', 'development_verified', 'packaged_verified', 'user_trial'];

let state = null;

check('01 状态源可解析', () => {
  state = loadState();
  return `schema_version=${state.schema_version} · updated_at=${state.updated_at}`;
});

check('02 必填字段与下一动作', () => {
  for (const k of ['schema_version', 'project', 'roles', 'active_task', 'next_action', 'tasks', 'budget']) {
    assert(state[k] !== undefined && state[k] !== null, `缺少字段 ${k}`);
  }
  assert(typeof state.next_action === 'string' && state.next_action.trim().length > 0, 'next_action 不能为空');
  assert(Array.isArray(state.tasks) && state.tasks.length > 0, 'tasks 不能为空');
  return '';
});

check('03 核心文件与任务目录', () => {
  for (const f of ['AGENTS.md', 'README.md', 'PLAN.md', 'CURRENT_STATE.md', 'HANDOFF.md',
    'docs/PRODUCT.md', 'docs/ARCHITECTURE.md', 'docs/UI_SPEC.md', 'docs/ACCEPTANCE.md',
    'docs/DECISIONS.md', 'docs/REFERENCES.md', 'package.json', '.gitignore',
    'scripts/lib.mjs', 'scripts/render-state.mjs', 'scripts/freeze-candidate.mjs']) {
    assert(existsSync(join(ROOT, f)), `核心文件缺失: ${f}`);
  }
  for (const t of state.tasks) {
    assert(existsSync(join(ROOT, 'tasks', t.id, 'plan.md')), `tasks/${t.id}/plan.md 缺失`);
  }
  return `${state.tasks.length} 个任务目录`;
});

check('04 恰好一个活动任务且未完成', () => {
  const active = state.tasks.filter((t) => t.id === state.active_task);
  assert(active.length === 1, `active_task=${state.active_task} 匹配到 ${active.length} 个任务`);
  assert(active[0].stage !== 'completed', '活动任务不应处于 completed 阶段');
  return state.active_task;
});

check('05 阶段与运行状态合法', () => {
  for (const t of state.tasks) {
    assert(STAGES.includes(t.stage), `${t.id} 阶段非法: ${t.stage}`);
    assert(RUN_STATES.includes(t.run_state), `${t.id} 运行状态非法: ${t.run_state}`);
  }
  return '';
});

check('06 已自查任务须有结果与证据', () => {
  const advanced = state.tasks.filter((t) =>
    ['self_checked', 'review_pending', 'reviewed', 'completed'].includes(t.stage));
  for (const t of advanced) {
    const result = readTextIfExists(join('tasks', t.id, 'result.md'));
    assert(result !== null && result.trim().length > 0, `tasks/${t.id}/result.md 缺失或为空`);
    const evDir = join(ROOT, 'tasks', t.id, 'evidence');
    assert(existsSync(evDir) && readdirSync(evDir).length > 0, `tasks/${t.id}/evidence/ 无证据文件`);
  }
  return `${advanced.length} 个任务已核查`;
});

check('07 未执行任务不预填通过', () => {
  const planned = state.tasks.filter((t) => t.stage === 'planned');
  for (const t of planned) {
    const result = readTextIfExists(join('tasks', t.id, 'result.md'));
    if (result !== null) {
      assert(/状态[:：]\s*未执行/.test(result), `tasks/${t.id}/result.md 存在但未标记「状态：未执行」`);
    }
  }
  return `${planned.length} 个未启动任务`;
});

check('08 候选哈希与记录一致', () => {
  const frozen = state.tasks.filter((t) => t.candidate);
  const archived = [];
  let verified = 0;
  for (const t of frozen) {
    // 语义（D-018）：活动任务的候选必须与当前内容一致（硬性）；
    // 非活动（历史）任务的候选被后续任务演进属于正常流转，绑定转为存档标注。
    const entries = collectScope(t.candidate_scope);
    const actual = hashCandidate(entries);
    const manifest = readTextIfExists(t.candidate.manifest);
    assert(manifest !== null && manifest.includes(t.candidate.hash),
      `${t.id} 候选清单缺失或哈希不匹配: ${t.candidate.manifest}`);
    if (actual === t.candidate.hash) {
      verified++;
    } else if (t.id === state.active_task) {
      throw new Error(
        `${t.id}（活动任务）候选哈希不符：记录 ${t.candidate.hash}，实际 ${actual}（内容已变化，需重新冻结并使旧审阅失效）`,
      );
    } else {
      archived.push(t.id);
    }
  }
  const note = archived.length ? ` · ${archived.length} 个历史候选已演进（存档绑定，增量由后续任务审阅覆盖）` : '';
  return `${verified}/${frozen.length} 个候选与当前内容一致${note}`;
});

check('09 审阅绑定（文件必须真实存在；活动任务强制；历史存档）', () => {
  const notes = [];
  for (const t of state.tasks) {
    const r = t.review || {};
    if (r.status === 'passed' && !['reviewed', 'completed'].includes(t.stage)) {
      throw new Error(`${t.id} 审阅标记通过但阶段为 ${t.stage}，状态矛盾`);
    }
    if (!['reviewed', 'completed'].includes(t.stage)) continue;
    assert(r.status === 'passed', `${t.id} 阶段为 ${t.stage} 但审阅未记录通过`);
    // R11：审阅文件必须真实存在，且正文含「通过」与绑定的候选哈希（防"标记通过但无审阅记录"）
    const reviewFile = readTextIfExists(join('tasks', t.id, 'review.md'));
    assert(reviewFile !== null, `${t.id} 标记已审阅但 tasks/${t.id}/review.md 不存在`);
    // T7：结构化结论——结论行枚举精确匹配：「通过」必须是结论行的完整值（「通过与否尚未决定」
    //     这类写法不算通过）；通过与 否决并存 = 冲突，不能过。
    assert(!/不通过|未通过|待复核|暂不通过|尚未决定/.test(reviewFile), `${t.id} review.md 含否决/未定表述，不能作为通过依据`);
    const cLines = reviewFile.split('\n').filter((l) => /(?:审阅结论|复核结论|结论|状态)[：:]/.test(l));
    const passCount = cLines.filter((l) => /(?:审阅结论|复核结论|结论|状态)[：:]\s*\*{0,2}已?通过\s*\*{0,2}\s*(?:（|，|。|;|；|｜|$)/.test(l)).length;
    const failCount = cLines.filter((l) => /(?:审阅结论|复核结论|结论|状态)[：:]\s*\*{0,2}(?:不通过|未通过|待复核|尚未通过)/.test(l)).length;
    assert(passCount >= 1 && failCount === 0,
      `${t.id} review.md 结论行异常：精确通过 ${passCount} 条、精确否决 ${failCount} 条（必须至少一条精确通过且无任何否决）`);
    const bound = r.reviewed_candidate;
    // S8：必须引用**完整**候选哈希（短哈希不算）
    assert(bound && reviewFile.includes(bound), `${t.id} review.md 未引用完整候选哈希`);
    const current = t.candidate && t.candidate.hash;
    if (bound && current && bound === current) continue;
    if (t.id === state.active_task) {
      throw new Error(
        `${t.id}（活动任务）审阅未绑定当前候选哈希（历史审阅不能作为当前版本的通过依据）`,
      );
    }
    notes.push(`${t.id} 绑定存档（增量由后续任务审阅覆盖）`);
  }
  return notes.length ? notes.join('；') : '全部绑定当前候选';
});

check('10 生成文件与状态源同步（渲染函数全文比对）', () => {
  const { hash, current, handoff } = buildGenerated(state);
  const pairs = [['CURRENT_STATE.md', current], ['HANDOFF.md', handoff]];
  for (const [f, expected] of pairs) {
    const text = readTextIfExists(f);
    assert(text !== null, `${f} 缺失，请运行 npm run state:render`);
    assert(text === expected, `${f} 与渲染函数输出不一致（正文被篡改或过时），请运行 npm run state:render`);
  }
  return `state:${hash}（全文比对一致）`;
});

check('11 Git 仓库与工作区', () => {
  const git = gitInfo();
  assert(git.head, 'Git 仓库未初始化或无提交');
  if (git.dirty > 0) {
    if (state.worktree && state.worktree.require_clean) {
      throw new Error(`工作区有 ${git.dirty} 处未提交变更（require_clean=true）`);
    }
    return `HEAD ${git.head.slice(0, 10)}，未提交 ${git.dirty} 处（警告：每轮结束应提交）`;
  }
  return `HEAD ${git.head.slice(0, 10)}，工作区干净`;
});

check('12 密钥泄露扫描（当前工作区，不含 Git 历史）', () => {
  const exts = new Set(['.md', '.json', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.jsx', '.txt', '.html', '.css', '.yml', '.yaml']);
  const patterns = [
    [/sk-[A-Za-z0-9]{16,}/, '疑似 API 密钥字面量'],
    [/Bearer\s+[A-Za-z0-9._-]{20,}/, '疑似 Bearer 凭据'],
    [/(api[_-]?key|secret|token)["']?\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/i, '疑似硬编码密钥赋值'],
  ];
  const hits = [];
  (function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git' || name === 'node_modules' || name === 'dist' || name === 'out') continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else {
        const dot = name.lastIndexOf('.');
        if (dot < 0 || !exts.has(name.slice(dot).toLowerCase()) || st.size > 512 * 1024) continue;
        const text = readFileSync(p, 'utf8');
        for (const [re, label] of patterns) {
          if (re.test(text)) hits.push(`${relative(ROOT, p).replace(/\\/g, '/')}（${label}）`);
        }
      }
    }
  })(ROOT);
  assert(hits.length === 0, `发现疑似密钥：${hits.join('; ')}`);
  return '未发现密钥字面量';
});

check('13 整树候选与发布验收状态', () => {
  const wt = state.worktree_whole || {};
  if (!wt.candidate) {
    return '未登记（允许：整改提交后由整树审阅轮冻结）';
  }
  assert(wt.manifest && existsSync(join(ROOT, wt.manifest)), `整树候选清单缺失: ${wt.manifest}`);
  const manifest = JSON.parse(readFileSync(join(ROOT, wt.manifest), 'utf8'));
  assert(manifest.hash === wt.candidate, '整树候选清单哈希与状态源不一致');
  // S8：逐文件重算；排除项（自引用状态元数据与易变文件）不参与聚合，另行由 10/09 覆盖
  // F8：排除正则必须匹配实际文件名 review.md（旧正则 review\.\w+\.md 只匹配 review.xxx.md，
  // 漏掉了活动审阅本身——审阅元数据仍会让整树候选自失效）
  const EXCLUDE = new Set(['project-state.json', 'CURRENT_STATE.md', 'HANDOFF.md']);
  const isExcluded = (p) => EXCLUDE.has(p) || /tasks\/[\w-]+\/evidence\//.test(p) || /tasks\/[\w-]+\/review\.md$/.test(p);
  // T7：独立枚举当前发布范围（git ls-files − 排除项），与清单文件集合比对——不依赖清单自定义完整范围
  const live = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).filter((p) => !isExcluded(p)),
  );
  const listed = new Set(manifest.files.map((f) => f.path).filter((p) => !isExcluded(p)));
  const added = [...live].filter((p) => !listed.has(p));
  const removed = [...listed].filter((p) => !live.has(p));
  assert(added.length === 0 && removed.length === 0,
    `整树清单与当前发布范围不符：新增 ${added.slice(0, 3).join(', ') || '无'}… 缺失 ${removed.slice(0, 3).join(', ') || '无'}…`);
  // T7：聚合绑定单文件 sha256（path\n byteLen\n fileSha256\n）——同长度内容改动无法保持旧整树哈希
  const agg = createHash('sha256');
  let counted = 0;
  for (const f of manifest.files) {
    if (isExcluded(f.path)) continue;
    const fp = join(ROOT, f.path);
    const buf = readFileSync(fp);
    const fileHash = createHash('sha256').update(buf).digest('hex');
    assert(fileHash === f.sha256, `整树候选内容漂移: ${f.path}`);
    agg.update(f.path + '\n' + buf.length + '\n' + fileHash + '\n');
    counted++;
  }
  assert('sha256:' + agg.digest('hex') === manifest.hash, '整树聚合哈希与内容不符（排除项之外存在未登记改动）');  const activeStage = state.tasks.find((t) => t.id === state.active_task)?.stage;
  return `整树候选 ${wt.candidate.slice(0, 19)}…（${manifest.files.length} 文件）· 验收状态 ${wt.acceptance ?? '未标注'} · 活动阶段 ${activeStage}`;
});

// —— 汇总 ——
const failed = checks.filter((c) => !c.ok);
const lines = [];
lines.push(`交接检查 handoff-check · ${new Date().toISOString()}`);
for (const c of checks) {
  lines.push(` ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
}
lines.push('');
lines.push(`结果：${checks.length} 项检查，${checks.length - failed.length} 通过，${failed.length} 失败`);
if (failed.length > 0) {
  lines.push('失败项：' + failed.map((c) => c.name).join('；'));
  lines.push('处理建议：按 AGENTS.md 第四节修复后重新运行 npm run state:render / candidate:freeze。');
}
console.log(lines.join('\n'));
process.exit(failed.length > 0 ? 1 : 0);
