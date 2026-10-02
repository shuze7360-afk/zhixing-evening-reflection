import { useCallback, useEffect, useState } from 'react';
import { PageShell, StatusChip } from '../components/PageShell';
import { useNav } from '../components/nav';
import type { ExportTaskRecord, ReportRecord } from '../../../shared/ipc';
import type { DailyReportContent } from '../../../shared/schemas';

type Row = ReportRecord & { exportTask: ExportTaskRecord | null };

export function RecordsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const reload = useCallback((): void => {
    window.zhixing.report
      .list({ limit: 60 })
      .then((r) => {
        if (r.ok) setRows((r.reports as Row[]) ?? []);
      })
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    reload();
    const off = window.zhixing.onAppEvent((e) => {
      if (e.type === 'export' || e.type === 'refine') reload();
    });
    return off;
  }, [reload]);

  const grouped = groupByDate(rows ?? []);

  return (
    <PageShell
      title="我的记录"
      description="历次日报与修订版本都保存在这里。修订另存新版本，不覆盖旧版本；导出到 Obsidian 是单向的。"
    >
      {flash && (
        <p className="mb-4 rounded-card border border-hot/30 bg-hot-soft px-4 py-3 text-[14px] text-ink" role="status">
          {flash}
        </p>
      )}

      {rows !== null && rows.length === 0 && (
        <section className="rounded-card border border-line bg-surface px-7 py-9">
          <h2 className="text-[17px] font-medium text-ink">还没有日报</h2>
          <p className="mt-2 max-w-[560px] text-[16px] leading-relaxed text-ink-3">
            完成第一次复盘后，这里会出现当天的日报；之后修改（例如确认一条行动）会形成新版本，不覆盖旧版本。
          </p>
        </section>
      )}

      <div className="flex flex-col gap-5">
        {grouped.map(([date, revs]) => (
          <section key={date} className="rounded-card border border-line bg-surface px-7 py-6">
            <div className="flex items-baseline justify-between">
              <h2 className="text-[17px] font-medium text-ink">{date}</h2>
              <span className="text-[13px] text-ink-3">{revs.length} 个修订</span>
            </div>
            <div className="mt-4 flex flex-col divide-y divide-line">
              {revs.map((r) => (
                <div key={r.id} className="py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="rounded-full bg-bg-sunk px-2.5 py-0.5 text-[13px] font-medium text-ink-2">
                      修订 v{r.rev}
                      {r.supersededBy ? '（已被更新版本替代）' : ''}
                    </span>
                    {!r.formal && (
                      <span className="rounded-full bg-amber-soft px-2.5 py-0.5 text-[13px] text-amber">草稿</span>
                    )}
                    <ExportChip task={r.exportTask} />
                    <button
                      type="button"
                      onClick={() => setOpen(open === r.id ? null : r.id)}
                      aria-expanded={open === r.id}
                      className="ml-auto text-[14px] text-accent underline-offset-4 hover:underline"
                    >
                      {open === r.id ? '收起' : '查看内容'}
                    </button>
                  </div>

                  {r.exportTask?.status === 'failed' && (
                    <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[14px]">
                      <span className="text-hot">导出失败：{r.exportTask.lastError}</span>
                      <button
                        type="button"
                        onClick={() => {
                          void window.zhixing.report
                            .exportRetry({ taskId: r.exportTask!.id })
                            .then((res) => {
                              if (!res.ok) setFlash(`重试导出失败：${'detail' in res ? res.detail : ''}`);
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
                            // F7：解决入口——选目录 → 绑定到任务 → 零模型重试导出；取消不写任何状态
                            void window.zhixing.dialog
                              .chooseDirectory()
                              .then((dir) => {
                                if (!dir) return { ok: false };
                                return window.zhixing.export.bindTargetAndRetry({ taskId: r.exportTask!.id, vaultDir: dir });
                              })
                              .then((res) => {
                                if (res && !res.ok) setFlash(`绑定目标失败：${'detail' in res && res.detail ? res.detail : '请重试'}`);
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
                          if (!res.ok) setFlash(res.detail ?? '无法打开位置');
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
                              if (!res.ok) setFlash(`重新核验失败：${'detail' in res && res.detail ? res.detail : '请重试'}`);
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
                              if (res && !res.ok) setFlash(`绑定目标失败：${'detail' in res && res.detail ? res.detail : '请重试'}`);
                              reload();
                            });
                        }}
                        className="rounded-control border border-accent/40 bg-accent-soft px-3 py-1 text-accent-ink hover:opacity-80"
                      >
                        选择目标目录并核验导出
                      </button>
                    </div>
                  )}

                  {open === r.id && <ReportContent json={r.contentJson} reportId={r.id} isLatest={!r.supersededBy} onChanged={reload} />}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </PageShell>
  );
}

function groupByDate(rows: Row[]): [string, Row[]][] {
  const map = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = map.get(r.date) ?? [];
    arr.push(r);
    map.set(r.date, arr);
  }
  return [...map.entries()];
}

function ExportChip({ task }: { task: ExportTaskRecord | null }) {
  if (!task) return <span className="text-[13px] text-ink-3">未导出</span>;
  if (task.status === 'done') return <StatusChip tone="ok" label="已导出" hint="Obsidian 笔记已生成" />;
  if (task.status === 'failed') return <StatusChip tone="fail" label="导出失败" hint="可重试，不重复生成" />;
  return <StatusChip tone="progress" label="导出中" hint="写入 Vault" />;
}

function ReportContent({
  json,
  reportId,
  isLatest,
  onChanged,
}: {
  json: string;
  reportId: string;
  isLatest: boolean;
  onChanged: () => void;
}) {
  let content: DailyReportContent;
  try {
    content = JSON.parse(json) as DailyReportContent;
  } catch {
    return <p className="mt-3 text-[14px] text-hot">日报内容解析失败。</p>;
  }

  const Sec = ({ title, items }: { title: string; items: string[] }): React.JSX.Element => (
    <div className="mt-4">
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

  return (
    <div className="mt-4 rounded-control border border-line bg-bg px-6 py-5">
      <p className="text-[14px] text-ink-3">覆盖范围：{content.coverage}</p>
      <Sec title="当天经历" items={content.experiences} />
      <div className="mt-4">
        <h3 className="text-[15px] font-medium text-ink">明确感受</h3>
        {(() => {
          // F3：同一感受不得在 feelings 与 feelings_confirmed 两处重复渲染——
          // 确认过的只显示一次（带已确认标记）
          const confirmed = content.feelings_confirmed ?? [];
          const plain = content.feelings.filter((f) => !confirmed.includes(f));
          if (plain.length === 0 && confirmed.length === 0) {
            return <p className="mt-1 text-[15px] text-ink-3">（无）</p>;
          }
          return (
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[16px] leading-relaxed text-ink">
              {plain.map((f, i) => (
                <li key={'f' + i}>{f}</li>
              ))}
              {confirmed.map((f, i) => (
                <li key={'cf' + i} className="font-medium">
                  {f} <span className="text-[13px] text-ok">（已确认）</span>
                </li>
              ))}
            </ul>
          );
        })()}
        {isLatest && content.ai_notes.some((n) => n.startsWith('（待核对感受）')) && (
          <div className="mt-2">
            <h4 className="text-[14px] text-ink-3">待确认感受（模型归纳，确认后成为正式感受）</h4>
            <ul className="mt-1 space-y-1.5">
              {content.ai_notes.filter((n) => n.startsWith('（待核对感受）')).map((n, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-[15px] text-ink-2">
                  {n}
                  <button
                    type="button"
                    onClick={() => {
                      void window.zhixing.report
                        .confirmFeeling({ reportId, item: n })
                        .then((r) => {
                          // F3：stale（已被新版本替代）等失败也刷新——待核对项从当前版移除后按钮即消失
                          onChanged();
                        });
                    }}
                    className="rounded-control border border-accent/40 bg-accent-soft px-2.5 py-0.5 text-[13px] text-accent-ink hover:opacity-80"
                  >
                    这确属我的感受（确认）
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <Sec title="值得保留的做法" items={content.keep_practices} />
      <Sec title="待验证的解释" items={content.open_questions} />
      <Sec title="相关思想（解读，非原文）" items={content.related_ideas.map((i) => `${i.idea}（来源：${i.source}）`)} />
      <Sec title="AI 假设（供核对，非事实）" items={content.ai_notes} />

      <div className="mt-4">
        <h3 className="text-[15px] font-medium text-ink">行动候选（未经确认，不视为已接受）</h3>
        {content.action_candidates.length === 0 ? (
          <p className="mt-1 text-[15px] text-ink-3">（无）</p>
        ) : (
          <ul className="mt-1.5 space-y-2">
            {content.action_candidates.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-3">
                <span className="text-[16px] text-ink">
                  {a.action}
                  {a.rationale ? <span className="text-ink-3"> —— {a.rationale}</span> : null}
                </span>
                {isLatest && (
                  <button
                    type="button"
                    onClick={() => {
                      void window.zhixing.report
                        .acceptAction({ reportId, index: i })
                        .then((res) => {
                          if (res.ok) onChanged();
                        });
                    }}
                    className="rounded-control border border-accent/40 bg-accent-soft px-3 py-1 text-[13px] text-accent-ink hover:opacity-80"
                  >
                    我要做这件事（确认后登记）
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {content.actions_accepted.length > 0 && (
          <div className="mt-3">
            <h3 className="text-[15px] font-medium text-ink">已确认的行动</h3>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[16px] text-ink">
              {content.actions_accepted.map((a, i) => (
                <li key={i}>{a.action}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
