import { useCallback, useEffect, useState } from 'react';
import { PageShell, StatusChip } from '../components/PageShell';
import type { PeriodReportRecord } from '../../../shared/ipc';

const KIND_CN: Record<PeriodReportRecord['kind'], string> = {
  weekly: '周报',
  monthly: '月报',
  yearly: '年报',
};

export function GrowthPage() {
  const [reports, setReports] = useState<PeriodReportRecord[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const reload = useCallback((): void => {
    window.zhixing.report
      .periodList()
      .then((r) => setReports(r.reports ?? []))
      .catch(() => setReports([]));
  }, []);

  useEffect(() => {
    reload();
    const off = window.zhixing.onAppEvent((e) => {
      if (e.type === 'export' || e.type === 'refine') reload();
    });
    return off;
  }, [reload]);

  const generate = (r: PeriodReportRecord): void => {
    setMsg(null);
    window.zhixing.report
      .periodGenerate({ kind: r.kind, start: r.periodStart, end: r.periodEnd })
      .then((res) => {
        if (res.ok) setMsg(`已生成新版本（修订 v${res.report?.bindings.rev}），旧版本保留。`);
        else setMsg(res.detail ?? '生成失败（可能预算超限或未配置 API Key）');
        reload();
      });
  };

  const groups = groupByKind(reports ?? []);

  return (
    <PageShell
      title="成长回顾"
      description="周报（周一至周日）、月报与年报：只基于真实记录回顾，覆盖范围与证据索引一并向你说明；空周期不会生成。"
    >
      {msg && (
        <p className="mb-4 rounded-card border border-line bg-surface px-4 py-3 text-[14px] text-ink" role="status">
          {msg}
        </p>
      )}
      <p className="mb-5 text-[14px] leading-relaxed text-ink-3">
        生成时机：周期结束后，应用运行且预算允许时自动生成；日报修订更新后，受影响的报告会标记「过时」，可重新生成新版本（旧版本保留）。
      </p>

      {reports === null && <p className="text-[16px] text-ink-3">正在读取…</p>}
      {reports?.length === 0 && (
        <section className="rounded-card border border-line bg-surface px-7 py-9">
          <h2 className="text-[17px] font-medium text-ink">还没有周期报告</h2>
          <p className="mt-2 max-w-[560px] text-[16px] leading-relaxed text-ink-3">
            积累一段时间的日报后会自动生成；记录太少时只呈现已有的部分，不会编造趋势。
          </p>
        </section>
      )}

      {(['weekly', 'monthly', 'yearly'] as const).map((kind) => {
        const rows = groups[kind];
        if (!rows || rows.length === 0) return null;
        return (
          <section key={kind} className="mt-5 rounded-card border border-line bg-surface px-7 py-6">
            <h2 className="text-[17px] font-medium text-ink">{KIND_CN[kind]}</h2>
            <div className="mt-4 flex flex-col divide-y divide-line">
              {rows.map((r) => (
                <div key={r.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[15px] font-medium text-ink">
                      {r.periodStart} ~ {r.periodEnd}
                    </span>
                    <span className="rounded-full bg-bg-sunk px-2.5 py-0.5 text-[12.5px] text-ink-2">
                      修订 v{r.bindings.rev}
                    </span>
                    {r.stale && (
                      <span className="rounded-full bg-amber-soft px-2.5 py-0.5 text-[12.5px] text-amber">
                        过时（绑定的日报已更新）
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-3">
                      {r.stale && (
                        <button
                          type="button"
                          onClick={() => generate(r)}
                          className="rounded-control border border-accent/40 bg-accent-soft px-3 py-1 text-[13px] text-accent-ink hover:opacity-80"
                        >
                          重新生成（保留旧版）
                        </button>
                      )}
                      <StatusChip
                        tone="ok"
                        label={`证据 ${r.bindings.daily_report_ids.length} 份`}
                        hint="日报索引"
                      />
                    </div>
                  </div>
                  <p className="mt-2 text-[14px] text-ink-3">覆盖范围：{r.coverage}</p>
                  <List title="值得记下" items={r.highlights} />
                  <List title="反复出现的模式" items={r.patterns} />
                  <List title="下周期值得验证" items={r.openQuestions} />
                  {/* G4：周期报告与日报同等的导出状态与解决入口——失败可重试；目标未定可选择目录（零模型调用） */}
                  {r.exportTask === null && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[14px]">
                      <span className="text-hot">导出尚未排程（此前排程未成功）</span>
                      <button
                        type="button"
                        onClick={() => {
                          void window.zhixing.report
                            .periodExportRetry({ reportId: r.id })
                            .then((res) => {
                              if (!res.ok) setMsg(`补做导出失败：${'detail' in res && res.detail ? res.detail : '请重试'}`);
                              else setMsg('已补做导出。');
                              reload();
                            });
                        }}
                        className="rounded-control border border-accent/40 bg-accent-soft px-3 py-1 text-accent-ink hover:opacity-80"
                      >
                        补做导出（不重新调用模型）
                      </button>
                    </div>
                  )}
                  {r.exportTask?.status === 'failed' && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[14px]">
                      <span className="text-hot">导出失败：{r.exportTask.lastError}</span>
                      <button
                        type="button"
                        onClick={() => {
                          void window.zhixing.report
                            .exportRetry({ taskId: r.exportTask!.id })
                            .then((res) => {
                              if (!res.ok) setMsg(`重试导出失败：${'detail' in res ? res.detail : ''}`);
                              reload();
                            });
                        }}
                        className="rounded-control border border-line-strong px-3 py-1 text-ink-2 hover:text-ink"
                      >
                        重试导出（不重新调用模型）
                      </button>
                      {r.exportTask.targetUnresolved && (
                        <button
                          type="button"
                          onClick={() => {
                            void window.zhixing.dialog
                              .chooseDirectory()
                              .then((dir) => {
                                if (!dir) return { ok: false };
                                return window.zhixing.export.bindTargetAndRetry({ taskId: r.exportTask!.id, vaultDir: dir });
                              })
                              .then((res) => {
                                if (res && !res.ok) setMsg(`绑定目标失败：${'detail' in res && res.detail ? res.detail : '请重试'}`);
                                else if (res && res.ok) setMsg('已绑定目标目录并完成导出。');
                                reload();
                              });
                          }}
                          className="rounded-control border border-accent/40 bg-accent-soft px-3 py-1 text-accent-ink hover:opacity-80"
                        >
                          选择目标目录并导出
                        </button>
                      )}
                    </div>
                  )}
                  {(r.exportTask?.status === 'pending' || r.exportTask?.status === 'running') && (
                    <p className="mt-2.5 text-[14px] text-ink-3">
                      导出任务待执行/恢复中；如长时间停留在此状态，重启应用会自动完成恢复（也可稍后在页面上重试）。
                    </p>
                  )}
                  {r.exportTask?.status === 'done' && !r.exportTask.targetUnresolved && !r.exportTask.targetInconsistent && (
                    <button
                      type="button"
                      onClick={() => {
                        void window.zhixing.export.openLocation({ taskId: r.exportTask!.id }).then((res) => {
                          if (!res.ok) setMsg(res.detail ?? '无法打开位置');
                        });
                      }}
                      className="mt-2.5 block text-[14px] text-ink-3 underline-offset-4 hover:text-ink hover:underline"
                    >
                      在 Obsidian 目录中显示（{r.exportTask.targetRel}）
                    </button>
                  )}
                  {r.exportTask?.status === 'done' && r.exportTask.targetInconsistent && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[14px]">
                      <span className="text-hot">该任务的记录路径与内容不一致（历史遗留），不能直接定位原路径。</span>
                      <button
                        type="button"
                        onClick={() => {
                          void window.zhixing.report
                            .exportRetry({ taskId: r.exportTask!.id })
                            .then((res) => {
                              if (!res.ok) setMsg(`重新核验失败：${'detail' in res && res.detail ? res.detail : '请重试'}`);
                              reload();
                            });
                        }}
                        className="rounded-control border border-accent/40 bg-accent-soft px-3 py-1 text-accent-ink hover:opacity-80"
                      >
                        重新核验导出（恢复正确路径）
                      </button>
                    </div>
                  )}
                  {r.exportTask?.status === 'done' && r.exportTask.targetUnresolved && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[14px]">
                      <span className="text-hot">该笔记的历史导出目标未确认，不能定位到当前全局目录中的同名文件。</span>
                      <button
                        type="button"
                        onClick={() => {
                          void window.zhixing.dialog
                            .chooseDirectory()
                            .then((dir) => {
                              if (!dir) return { ok: false };
                              return window.zhixing.export.bindTargetAndRetry({ taskId: r.exportTask!.id, vaultDir: dir });
                            })
                            .then((res) => {
                              if (res && !res.ok) setMsg(`绑定目标失败：${'detail' in res && res.detail ? res.detail : '请重试'}`);
                              else if (res && res.ok) setMsg('已确认目标目录并重新核验导出。');
                              reload();
                            });
                        }}
                        className="rounded-control border border-accent/40 bg-accent-soft px-3 py-1 text-accent-ink hover:opacity-80"
                      >
                        选择目标目录并核验导出
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </PageShell>
  );
}

function List({ title, items }: { title: string; items: string[] }): React.JSX.Element {
  return (
    <div className="mt-3">
      <h3 className="text-[15px] font-medium text-ink">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-[15px] text-ink-3">（无）</p>
      ) : (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[16px] leading-relaxed text-ink">
          {items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function groupByKind(rows: PeriodReportRecord[]): Record<PeriodReportRecord['kind'], PeriodReportRecord[]> {
  const g: Record<PeriodReportRecord['kind'], PeriodReportRecord[]> = { weekly: [], monthly: [], yearly: [] };
  for (const r of rows) g[r.kind].push(r);
  return g;
}
