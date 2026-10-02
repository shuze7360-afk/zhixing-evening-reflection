import { useEffect, useState } from 'react';
import { PageShell, StatusChip } from '../components/PageShell';
import type { ExperimentRecord } from '../../../shared/ipc';

const EMPTY_FORM = {
  h1: '', h2: '', h3: '', keyIndex: 0,
  action: '', invest: '', periodDays: 3, metric: '', continueRule: '', stopRule: '', firstStep: '',
};

export function ExperimentsPage() {
  const [items, setItems] = useState<ExperimentRecord[] | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [msg, setMsg] = useState<string | null>(null);
  const [observeText, setObserveText] = useState('');
  const [concludeFor, setConcludeFor] = useState<string | null>(null);
  const [outcome, setOutcome] = useState('');
  const [conclusion, setConclusion] = useState('');

  const reload = (): void => {
    window.zhixing.experiments
      .list()
      .then((r) => setItems(r.experiments ?? []))
      .catch(() => setItems([]));
  };
  useEffect(reload, []);

  const active = items?.find((e) => e.status === 'running') ?? null;

  const submit = (): void => {
    const args = {
      hypotheses: [form.h1, form.h2, form.h3] as [string, string, string],
      keyIndex: form.keyIndex,
      action: form.action,
      invest: form.invest,
      periodDays: form.periodDays,
      metric: form.metric,
      continueRule: form.continueRule,
      stopRule: form.stopRule,
      firstStep: form.firstStep,
    };
    window.zhixing.experiments.create(args).then((r) => {
      if (r.ok) {
        setForm(EMPTY_FORM);
        setFormOpen(false);
        setMsg(null);
        reload();
      } else {
        setMsg(r.detail === 'active_exists' ? '同时最多一个进行中的实验：先结束当前实验。' : (r.detail ?? '创建失败'));
      }
    });
  };

  const observe = (id: string): void => {
    window.zhixing.experiments.observe({ id, text: observeText }).then((r) => {
      if (r.ok) {
        setObserveText('');
        reload();
      } else setMsg(r.detail ?? '记录失败');
    });
  };

  const conclude = (id: string): void => {
    window.zhixing.experiments.conclude({ id, outcome, conclusion }).then((r) => {
      if (r.ok) {
        setConcludeFor(null);
        setOutcome('');
        setConclusion('');
        reload();
      } else setMsg(r.detail ?? '结束失败');
    });
  };

  return (
    <PageShell
      title="小实验"
      description="把改进建议变成 ≤7 天、低成本、可验证的最小实验：三个假设选最关键的，用现实反馈代替空想。"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {active ? (
            <StatusChip tone="progress" label="进行中" hint={`${dueText(active)} 到期回访`} />
          ) : (
            <span className="text-[14px] text-ink-3">当前没有进行中的实验</span>
          )}
        </div>
        <button
          type="button"
          disabled={!!active}
          onClick={() => setFormOpen((v) => !v)}
          aria-expanded={formOpen}
          className="rounded-control border border-line-strong px-4 py-2 text-[14px] text-ink-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          title={active ? '同时最多一个进行中的实验' : undefined}
        >
          {formOpen ? '收起' : '新建实验'}
        </button>
      </div>

      {msg && <p className="mt-3 text-[14px] text-hot">{msg}</p>}

      {formOpen && !active && (
        <section className="mt-4 rounded-card border border-line bg-surface px-7 py-6">
          <h2 className="text-[16px] font-medium text-ink">新建最小实验</h2>
          <p className="mt-1 text-[14px] text-ink-3">
            先写下三个可能影响结论的假设，再选你认为最关键的一个去验证。
          </p>
          <div className="mt-4 space-y-3">
            {([0, 1, 2] as const).map((i) => (
              <label key={i} className="flex items-start gap-3">
                <input
                  type="radio"
                  name="key-hypothesis"
                  checked={form.keyIndex === i}
                  onChange={() => setForm({ ...form, keyIndex: i })}
                  className="mt-2.5"
                  aria-label={`设为关键假设 ${i + 1}`}
                />
                <span className="flex-1">
                  <span className="mb-1 block text-[14px] text-ink-3">
                    假设 {i + 1}{form.keyIndex === i ? '（最关键）' : ''}
                  </span>
                  <input
                    value={form[`h${i + 1}` as 'h1']}
                    onChange={(e) => setForm({ ...form, [`h${i + 1}`]: e.target.value })}
                    maxLength={300}
                    placeholder={i === 0 ? '例如：睡够 7 小时能让第二天写作更顺…' : ''}
                    className="w-full rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
                  />
                </span>
              </label>
            ))}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="动作（明确做什么）" value={form.action} onChange={(v) => setForm({ ...form, action: v })} placeholder="每天 22:30 前上床，手机放客厅" />
            <Field label="投入" value={form.invest} onChange={(v) => setForm({ ...form, invest: v })} placeholder="几乎零成本，只是调整习惯" />
            <Field label="观察指标" value={form.metric} onChange={(v) => setForm({ ...form, metric: v })} placeholder="早上第一小时的写作字数" />
            <label className="text-[14px] text-ink-3">
              周期（天，≤7）
              <input
                type="number"
                min={1}
                max={7}
                value={form.periodDays}
                onChange={(e) => setForm({ ...form, periodDays: Math.min(7, Math.max(1, Number(e.target.value) || 1)) })}
                className="mt-1 w-full rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <Field label="继续条件" value={form.continueRule} onChange={(v) => setForm({ ...form, continueRule: v })} placeholder="写作字数连续 3 天提升" />
            <Field label="停止条件" value={form.stopRule} onChange={(v) => setForm({ ...form, stopRule: v })} placeholder="连续 2 天失败就放弃并复盘" />
            <Field label="明天能开始的第一步" value={form.firstStep} onChange={(v) => setForm({ ...form, firstStep: v })} placeholder="今晚把手机充电器挪到客厅" />
          </div>
          <button
            type="button"
            onClick={submit}
            disabled={!form.h1.trim() || !form.h2.trim() || !form.h3.trim() || !form.action.trim() || !form.firstStep.trim()}
            className="mt-5 rounded-control bg-accent px-5 py-2.5 text-[15px] font-medium text-accent-contrast hover:opacity-90 disabled:opacity-50"
          >
            开始实验
          </button>
        </section>
      )}

      <div className="mt-6 flex flex-col gap-4">
        {items === null && <p className="text-[16px] text-ink-3">正在读取…</p>}
        {items?.length === 0 && !formOpen && (
          <p className="rounded-card border border-dashed border-line px-6 py-8 text-center text-[15px] text-ink-3">
            还没有实验：复盘结束后，可以把一条“也许可以”立成小实验——只有你确认的行动才值得验证。
          </p>
        )}
        {items?.map((e) => (
          <article key={e.id} className="rounded-card border border-line bg-surface px-7 py-6">
            <div className="flex flex-wrap items-center gap-2.5">
              {e.status === 'running' ? (
                <StatusChip tone="progress" label="进行中" hint={dueText(e)} />
              ) : e.status === 'planned' ? (
                <StatusChip tone="progress" label="草稿" hint="确认后开始" />
              ) : (
                <StatusChip tone="ok" label="已结束" hint="结论已登记" />
              )}
              <span className="text-[13px] text-ink-3">周期 {e.periodDays} 天</span>
            </div>

            <ol className="mt-3 space-y-1.5 text-[15px] text-ink-2">
              {e.hypotheses.map((h, i) => (
                <li key={i} className={i === e.keyIndex ? 'font-medium text-ink' : ''}>
                  {i === e.keyIndex ? '★ ' : `${i + 1}. `}{h}
                  {i === e.keyIndex && <span className="ml-1.5 text-[13px] text-accent">（最关键假设）</span>}
                </li>
              ))}
            </ol>
            <p className="mt-3 text-[16px] text-ink"><span className="text-ink-3">动作：</span>{e.action}</p>
            {e.metric && <p className="mt-1 text-[15px] text-ink-2"><span className="text-ink-3">指标：</span>{e.metric}</p>}
            {(e.continueRule || e.stopRule) && (
              <p className="mt-1 text-[14px] text-ink-3">
                {e.continueRule && <>继续：{e.continueRule}　</>}
                {e.stopRule && <>停止：{e.stopRule}</>}
              </p>
            )}

            {e.observations.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-line pt-3 text-[14px] text-ink-2">
                {e.observations.map((o, i) => (
                  <li key={i}>· {o.text} <span className="text-ink-3">（{o.createdAt.slice(5, 16).replace('T', ' ')}）</span></li>
                ))}
              </ul>
            )}

            {e.status === 'planned' && (
              <div className="mt-4 border-t border-line pt-4">
                <p className="text-[14px] text-ink-3">
                  这是一份草稿（可能来自 MCP 导入）：确认后开始计时，同时最多一个进行中的实验。
                </p>
                <button
                  type="button"
                  onClick={() => {
                    void window.zhixing.experiments.start({ id: e.id }).then((r) => {
                      if (r.ok) reload();
                      else setMsg(r.detail ?? '启动失败');
                    });
                  }}
                  className="mt-3 rounded-control bg-accent px-4 py-2 text-[15px] font-medium text-accent-contrast hover:opacity-90"
                >
                  确认开始实验
                </button>
              </div>
            )}

            {e.status === 'running' && (
              <div className="mt-4 border-t border-line pt-4">
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    value={observeText}
                    onChange={(ev) => setObserveText(ev.target.value)}
                    maxLength={500}
                    placeholder="记录一条观察…"
                    className="min-w-[240px] flex-1 rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={!observeText.trim()}
                    onClick={() => observe(e.id)}
                    className="rounded-control border border-line-strong px-4 py-2 text-[14px] text-ink-2 hover:text-ink disabled:opacity-50"
                  >
                    记录观察
                  </button>
                  <button
                    type="button"
                    onClick={() => setConcludeFor(concludeFor === e.id ? null : e.id)}
                    className="rounded-control border border-line-strong px-4 py-2 text-[14px] text-ink-2 hover:text-ink"
                  >
                    {concludeFor === e.id ? '取消' : '结束并下结论'}
                  </button>
                </div>
                {concludeFor === e.id && (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={outcome}
                      onChange={(ev) => setOutcome(ev.target.value)}
                      rows={2}
                      maxLength={2000}
                      placeholder="实际结果（观察到什么，不评价自己）"
                      className="w-full resize-none rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
                    />
                    <textarea
                      value={conclusion}
                      onChange={(ev) => setConclusion(ev.target.value)}
                      rows={2}
                      maxLength={2000}
                      placeholder="结论与调整（根据实际结果，判断要怎么改）"
                      className="w-full resize-none rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
                    />
                    <button
                      type="button"
                      disabled={!outcome.trim() || !conclusion.trim()}
                      onClick={() => conclude(e.id)}
                      className="rounded-control bg-accent px-4 py-2 text-[15px] font-medium text-accent-contrast hover:opacity-90 disabled:opacity-50"
                    >
                      登记结论
                    </button>
                  </div>
                )}
              </div>
            )}

            {e.status === 'concluded' && e.conclusion && (
              <div className="mt-3 border-t border-line pt-3 text-[15px] leading-relaxed">
                <p className="text-ink-2"><span className="text-ink-3">实际结果：</span>{e.conclusion.outcome}</p>
                <p className="mt-1 text-ink-2"><span className="text-ink-3">结论与调整：</span>{e.conclusion.conclusion}</p>
              </div>
            )}
          </article>
        ))}
      </div>
    </PageShell>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block text-[14px] text-ink-3">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={500}
        placeholder={placeholder}
        className="mt-1 w-full rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
      />
    </label>
  );
}

function dueText(e: ExperimentRecord): string {
  const due = new Date(new Date(e.startedAt).getTime() + e.periodDays * 86_400_000);
  const days = Math.ceil((due.getTime() - Date.now()) / 86_400_000);
  return days > 0 ? `${days} 天后` : '已到';
}
