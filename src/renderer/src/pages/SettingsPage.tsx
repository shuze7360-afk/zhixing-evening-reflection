import { useEffect, useState } from 'react';
import { PageShell } from '../components/PageShell';
import { ThemeSwitch } from '../components/ThemeSwitch';
import { ERROR_HINT } from '../api';
import type { PublicSettings, TestConnectionResult } from '../../../shared/ipc';

export function SettingsPage() {
  const [s, setS] = useState<PublicSettings | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyMsg, setKeyMsg] = useState<string | null>(null);
  const [obsidianDir, setObsidianDir] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [budget, setBudget] = useState('');
  const [priceIn, setPriceIn] = useState('');
  const [priceOut, setPriceOut] = useState('');
  const [priceCheckedAt, setPriceCheckedAt] = useState('');
  const [remStart, setRemStart] = useState('21:30');
  const [remEnd, setRemEnd] = useState('23:00');
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);

  const load = (): void => {
    window.zhixing.settings
      .get()
      .then((v) => {
        setS(v);
        setObsidianDir(v.obsidianDir);
        setApiBaseUrl(v.apiBaseUrl ?? '');
        setModel(v.model ?? '');
        setBudget(String(v.budgetMonthlyCny));
        setPriceIn(String(v.priceInCnyPerMtok));
        setPriceOut(String(v.priceOutCnyPerMtok));
        setPriceCheckedAt(v.priceCheckedAt ?? '');
        setRemStart(v.reminderStart);
        setRemEnd(v.reminderEnd);
      })
      .catch(() => setS(null));
  };

  useEffect(load, []);

  const save = (patch: Record<string, unknown>, okText: string): void => {
    window.zhixing.settings
      .set(patch)
      .then((r) => {
        setSaveMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.detail ?? '保存失败' });
        load();
      })
      .catch((e: Error) => setSaveMsg({ ok: false, text: e.message }));
  };

  return (
    <PageShell
      title="设置"
      description="连接、导出与预算都在这里配置。API Key 加密保存在本机，不写入任何文件明文。"
    >
      {/* 连接 */}
      <section className="rounded-card border border-line bg-surface px-7 py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[17px] font-medium text-ink">模型连接</h2>
          <span className="text-[13px] text-ink-3">
            {s?.hasApiKey ? 'API Key 已配置（safeStorage 加密）' : 'API Key 未配置'}
          </span>
        </div>
        <p className="mt-1 text-[13px] text-ink-3">
          默认使用 BigModel（glm-5.3-flash）；也可配置为任何 OpenAI 兼容接口（DeepSeek、Moonshot、OpenAI、本地 Ollama 等）：
          接口地址填到版本根（如 https://api.deepseek.com/v1），模型名填该服务提供的模型 ID。
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-[14px] text-ink-2">
            接口地址（Base URL，留空恢复默认）
            <input
              type="text"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="https://open.bigmodel.cn/api/paas/v4"
              autoComplete="off"
              className="mt-1 w-full rounded-control border border-line-strong bg-bg px-4 py-2.5 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
          </label>
          <label className="text-[14px] text-ink-2">
            模型名（留空恢复默认）
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="glm-5.3-flash"
              autoComplete="off"
              className="mt-1 w-full rounded-control border border-line-strong bg-bg px-4 py-2.5 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
          </label>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={() => save({ apiBaseUrl: apiBaseUrl.trim(), model: model.trim() }, '模型连接已保存。')}
            className="rounded-control border border-line-strong px-3 py-1 text-[14px] text-ink-2 hover:text-ink"
          >
            保存接口与模型
          </button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="粘贴 API Key（sk-…；保存后不回显）"
            autoComplete="off"
            className="min-w-[280px] flex-1 rounded-control border border-line-strong bg-bg px-4 py-2.5 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            disabled={!keyInput.trim()}
            onClick={() => {
              setKeyMsg(null);
              window.zhixing.settings
                .set({ apiKey: keyInput.trim() })
                .then((r) => {
                  if (r.ok) {
                    setKeyMsg('已加密保存。');
                    setKeyInput('');
                  } else {
                    setKeyMsg(r.detail ?? '保存失败');
                  }
                  load();
                })
                .catch((e: Error) => setKeyMsg(e.message));
            }}
            className="rounded-control bg-accent px-4 py-2.5 text-[15px] font-medium text-accent-contrast hover:opacity-90 disabled:opacity-50"
          >
            保存 Key
          </button>
          <button
            type="button"
            disabled={testing}
            onClick={() => {
              setTesting(true);
              setTestResult(null);
              window.zhixing.settings
                .testConnection()
                .then(setTestResult)
                .finally(() => setTesting(false));
            }}
            className="rounded-control border border-line-strong px-4 py-2.5 text-[15px] text-ink-2 hover:text-ink disabled:opacity-50"
          >
            {testing ? '测试中…' : '测试连接'}
          </button>
        </div>
        {keyMsg && <p className="mt-2 text-[14px] text-ink-2">{keyMsg}</p>}
        {saveMsg && <p className={`mt-2 text-[14px] ${saveMsg.ok ? 'text-ok' : 'text-hot'}`}>{saveMsg.text}</p>}
        {testResult && (
          <div
            className={`mt-4 rounded-control border px-4 py-3 text-[15px] leading-relaxed ${
              testResult.ok ? 'border-ok/30 bg-ok-soft text-ink' : 'border-hot/30 bg-hot-soft text-ink'
            }`}
            role="status"
          >
            {testResult.ok ? (
              <>
                ✓ {testResult.message}（{testResult.elapsedMs} ms
                {testResult.usageTokens ? `，用量 ${testResult.usageTokens} tokens` : ''}）
              </>
            ) : (
              <>
                ✗ {testResult.message}
                {testResult.errorClass && ERROR_HINT[testResult.errorClass] && (
                  <span className="block text-[14px] text-ink-3">{ERROR_HINT[testResult.errorClass]}</span>
                )}
                {testResult.raw && (
                  <span className="mt-1 block break-all text-[13px] text-ink-3">接口返回：{testResult.raw}</span>
                )}
              </>
            )}
          </div>
        )}
        <p className="mt-3 text-[14px] leading-relaxed text-ink-3">
          实际权限与余额以「测试连接」结果为准；本应用不使用任何其他额度渠道，也不会自动切换模型或计费接口。
        </p>
      </section>

      {/* Obsidian */}
      <section className="mt-5 rounded-card border border-line bg-surface px-7 py-6">
        <h2 className="text-[17px] font-medium text-ink">Obsidian 导出目录</h2>
        <p className="mt-1.5 text-[16px] leading-relaxed text-ink-3">
          日报写入该目录下的「日报」子文件夹（首次导出时自动创建）。导出是单向的：手工修改不会回流应用，也不会被覆盖。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={obsidianDir}
            onChange={(e) => setObsidianDir(e.target.value)}
            className="min-w-[320px] flex-1 rounded-control border border-line-strong bg-bg px-4 py-2.5 text-[15px] text-ink focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              void window.zhixing.dialog.chooseDirectory().then((dir) => {
                if (dir) setObsidianDir(dir);
              });
            }}
            className="rounded-control border border-line-strong px-4 py-2.5 text-[15px] text-ink-2 hover:text-ink"
          >
            选择目录…
          </button>
          <button
            type="button"
            onClick={() => save({ obsidianDir }, '导出目录已保存。')}
            className="rounded-control bg-accent px-4 py-2.5 text-[15px] font-medium text-accent-contrast hover:opacity-90"
          >
            保存
          </button>
        </div>
      </section>

      {/* 预算与价格 */}
      <section className="mt-5 rounded-card border border-line bg-surface px-7 py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[17px] font-medium text-ink">月度预算</h2>
          <span className="text-[13px] text-ink-3">
            本月已用约 {s?.monthlySpendCny ?? 0} / {s?.budgetMonthlyCny ?? 20} 元（按调用前预占 + usage 结算）
          </span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label className="text-[15px] text-ink-2" htmlFor="budget-input">
            上限（元/月）
          </label>
          <input
            id="budget-input"
            type="number"
            min="1"
            step="1"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className="w-[120px] rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => {
              const n = Number(budget);
              if (Number.isFinite(n) && n > 0) save({ budgetMonthlyCny: n }, '预算已更新。');
            }}
            className="rounded-control bg-accent px-4 py-2 text-[15px] font-medium text-accent-contrast hover:opacity-90"
          >
            保存
          </button>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-[15px] font-medium text-ink">模型单价（元 / 百万 tokens）</h3>
          {s?.priceIsPlaceholder && (
            <p className="mt-1 text-[14px] text-amber">
              当前使用占位价 8 元/M 进行保守预占（未核实）。请以 BigModel 控制台实际价格为准填写并记录核查日期。
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3 text-[15px] text-ink-2">
            <label htmlFor="price-in">输入</label>
            <input
              id="price-in"
              type="number"
              min="0"
              step="0.5"
              value={priceIn}
              onChange={(e) => setPriceIn(e.target.value)}
              className="w-[100px] rounded-control border border-line-strong bg-bg px-3 py-2 text-ink focus:border-accent focus:outline-none"
            />
            <label htmlFor="price-out">输出</label>
            <input
              id="price-out"
              type="number"
              min="0"
              step="0.5"
              value={priceOut}
              onChange={(e) => setPriceOut(e.target.value)}
              className="w-[100px] rounded-control border border-line-strong bg-bg px-3 py-2 text-ink focus:border-accent focus:outline-none"
            />
            <label htmlFor="price-date">核查日期</label>
            <input
              id="price-date"
              value={priceCheckedAt}
              onChange={(e) => setPriceCheckedAt(e.target.value)}
              placeholder="如 2026-10-01"
              className="w-[130px] rounded-control border border-line-strong bg-bg px-3 py-2 text-ink focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                const i = Number(priceIn);
                const o = Number(priceOut);
                if (Number.isFinite(i) && i > 0 && Number.isFinite(o) && o > 0) {
                  save(
                    { priceInCnyPerMtok: i, priceOutCnyPerMtok: o, priceCheckedAt: priceCheckedAt || null },
                    '单价与核查日期已保存。',
                  );
                }
              }}
              className="rounded-control bg-accent px-4 py-2 text-[15px] font-medium text-accent-contrast hover:opacity-90"
            >
              保存
            </button>
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-3">
            本预算只约束本应用自己的调用，不代表你 BigModel 账户中其他应用的费用。
          </p>
        </div>
      </section>

      {/* 外观 */}
      <section className="mt-5 rounded-card border border-line bg-surface px-7 py-6">
        <h2 className="text-[17px] font-medium text-ink">外观</h2>
        <p className="mt-1.5 text-[16px] text-ink-3">浅色 / 深色 / 跟随系统，偏好会记住。</p>
        <div className="mt-4 max-w-[340px]">
          <ThemeSwitch />
        </div>
      </section>

      {/* 提醒（ER-004 已接入） */}
      <section className="mt-5 rounded-card border border-line bg-surface px-7 py-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[17px] font-medium text-ink">提醒窗口</h2>
          <span className="text-[13px] text-ink-3">
            每天 {s?.reminderStart ?? '21:30'}—{s?.reminderEnd ?? '23:00'} 最多提醒一次
          </span>
        </div>
        <p className="mt-1.5 text-[16px] leading-relaxed text-ink-3">
          窗口内提醒一次；当天已完成复盘或已有进行中的对话则不打扰。错过不补发、不唤醒电脑；关闭窗口只是进入托盘，彻底退出请用托盘菜单。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-[15px] text-ink-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={s?.reminderEnabled ?? true}
              onChange={(e) => save({ reminderEnabled: e.target.checked }, '提醒开关已更新。')}
            />
            启用提醒
          </label>
          <label htmlFor="rem-start">开始</label>
          <input
            id="rem-start"
            value={remStart}
            onChange={(e) => setRemStart(e.target.value)}
            placeholder="21:30"
            className="w-[100px] rounded-control border border-line-strong bg-bg px-3 py-2 text-ink focus:border-accent focus:outline-none"
          />
          <label htmlFor="rem-end">结束</label>
          <input
            id="rem-end"
            value={remEnd}
            onChange={(e) => setRemEnd(e.target.value)}
            placeholder="23:00"
            className="w-[100px] rounded-control border border-line-strong bg-bg px-3 py-2 text-ink focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => save({ reminderStart: remStart, reminderEnd: remEnd }, '提醒窗口已保存。')}
            className="rounded-control bg-accent px-4 py-2 text-[15px] font-medium text-accent-contrast hover:opacity-90"
          >
            保存
          </button>
        </div>
      </section>

      {/* 备份与恢复 */}
      <section className="mt-5 rounded-card border border-line bg-surface px-7 py-6">
        <h2 className="text-[17px] font-medium text-ink">备份与恢复</h2>
        <p className="mt-1.5 text-[16px] leading-relaxed text-ink-3">
          备份生成数据库一致快照（含复盘、日报、思想库与实验）。API Key 与机器绑定不随备份迁移：恢复后请在设置中重新输入。
          恢复在你确认后于下次启动时生效，当前数据会先自动留档。
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              void window.zhixing.dialog.chooseDirectory().then((dir) => {
                if (!dir) return;
                void window.zhixing.data.backup({ targetDir: dir }).then((r) => {
                  setSaveMsg(r.ok ? { ok: true, text: `已备份：${r.file}` } : { ok: false, text: r.error ?? '备份失败' });
                });
              });
            }}
            className="rounded-control bg-accent px-4 py-2 text-[15px] font-medium text-accent-contrast hover:opacity-90"
          >
            备份到目录…
          </button>
          <button
            type="button"
            onClick={() => {
              void window.zhixing.data.restore().then((r) => {
                if (r.ok && r.requested) {
                  setSaveMsg({ ok: true, text: `校验通过（${Object.entries(r.counts ?? {}).map(([k, v]) => `${k} ${v}`).join('，') || '空库'}）。已安排恢复：重启应用后生效。` });
                } else if (r.ok) {
                  setSaveMsg({ ok: true, text: '已取消。' });
                } else {
                  setSaveMsg({ ok: false, text: r.detail ?? '恢复失败' });
                }
              });
            }}
            className="rounded-control border border-line-strong px-4 py-2 text-[15px] text-ink-2 hover:text-ink"
          >
            从备份恢复…
          </button>
        </div>
      </section>

      <p className="mt-6 text-[14px] text-ink-3">数据目录（数据库与本地记录）：{s?.dataDir ?? '…'}</p>
    </PageShell>
  );
}
