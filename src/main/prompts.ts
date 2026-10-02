// 提示词加载（docs/DECISIONS.md D-017）：resources/prompts/<版本>/<名称>.md。
// 不直接依赖 electron：基础路径由入口注入（开发=项目根/resources，打包=process.resourcesPath/resources）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadPrompt(baseDir: string, version: string, name: string): string {
  const file = join(baseDir, 'prompts', version, `${name}.md`);
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`提示词缺失：prompts/${version}/${name}.md（${(err as Error).message}）`);
  }
}

export function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key: string) =>
    key in vars ? vars[key] : m,
  );
}
