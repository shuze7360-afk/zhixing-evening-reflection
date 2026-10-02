// 从唯一状态源 project-state.json 生成 CURRENT_STATE.md 与 HANDOFF.md。
// 这两个文件禁止手工编辑；状态源变化后重新运行 npm run state:render。
// 模板在 scripts/render-lib.mjs（交接检查用同一函数做全文比对——S8）。
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadState } from './lib.mjs';
import { buildGenerated } from './render-lib.mjs';

const state = loadState();
const { current, handoff } = buildGenerated(state);
writeFileSync(join(ROOT, 'CURRENT_STATE.md'), current, 'utf8');
writeFileSync(join(ROOT, 'HANDOFF.md'), handoff, 'utf8');
console.log(`state:render 完成 · CURRENT_STATE.md 与 HANDOFF.md 已重新生成`);
