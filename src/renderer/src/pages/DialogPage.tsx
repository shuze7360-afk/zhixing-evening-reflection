import { useCallback, useEffect, useRef, useState } from 'react';
import { PageShell, StatusChip } from '../components/PageShell';
import { useNav } from '../components/nav';
import { ERROR_HINT, PHASE_LABEL, STATE_LABEL, stateTone } from '../api';
import type { MessageRecord, OpResult, TodaySnapshot } from '../../../shared/ipc';

interface Banner {
  tone: 'ok' | 'progress' | 'fail';
  text: string;
  retryable?: boolean; // 上一轮可显式重试（超时/网络中断）
}

export function DialogPage() {
  const navigate = useNav();
  const [snap, setSnap] = useState<TodaySnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [input, setInput] = useState('');
  const sessionRef = useRef<string | null>(null);
  const session = snap?.session ?? null;
  const sessionId = session?.id ?? null;
  sessionRef.current = sessionId;

  const reload = useCallback((): Promise<void> => {
    return window.zhixing.session
      .getToday()
      .then((s) => {
        setSnap(s);
        if (s.session?.status === 'closed' && s.latestReport) {
          setStreamText(null);
        }
      })
      .catch(() => setSnap(null));
  }, []);

  useEffect(() => {
    void reload().finally(() => setLoaded(true));
  }, [reload]);

  // 模型流事件：只处理当前会话
  useEffect(() => {
    const off = window.zhixing.onModelEvent((e) => {
      if (e.sessionId !== sessionRef.current) return;
      if (e.type === 'delta') {
        setStreamText((prev) => (prev ?? '') + e.text);
      } else if (e.type === 'done') {
        setStreamText(null);
        setBanner(null);
        setConfirmEnd(false);
        void reload();
      } else {
        setStreamText(null);
        setBanner({
          tone: 'fail',
          text: e.error,
          retryable: e.errorClass === 'timeout' || e.errorClass === 'network',
        });
        void reload();
      }
    });
    return off;
  }, [reload]);

  // 应用事件：提炼 / 导出 / 预算
  useEffect(() => {
    const off = window.zhixing.onAppEvent((e) => {
      if (e.type === 'refine') {
        if (e.sessionId !== sessionRef.current) return;
        if (e.status === 'started') {
          setBanner({ tone: 'progress', text: '正在提炼日报…' });
        } else if (e.status === 'ok') {
          // R3：提炼成功 ≠ 已导出。导出状态由 export 事件另行汇报。
          setBanner({ tone: 'ok', text: `日报已生成（修订 v${e.rev}）。正在保存到 Obsidian…` });
          void reload();
        } else {
          setBanner({ tone: 'fail', text: e.message ?? '提炼失败，可重试。' });
          void reload();
        }
      } else if (e.type === 'export') {
        void reload();
        if (e.status === 'done') {
          setBanner({ tone: 'ok', text: `已保存到 Obsidian（${e.targetRel ?? '日报'}）。` });
        } else if (e.status === 'failed') {
          // 导出失败：日报保留，可仅重试文件导出（不重新调用模型）——见"我的记录"页
          setBanner({ tone: 'fail', text: `日报已生成，但导出到 Obsidian 失败：${e.error ?? '未知原因'}。可在"我的记录"页重试导出。` });
        }
      } else if (e.type === 'budget') {
        if (e.paused) {
          setBanner({
            tone: 'fail',
            text: `本月模型费用已达上限（${e.monthlySpendCny} / ${e.limitCny} 元），已暂停调用；本地记录不受影响。`,
          });
        }
      }
    });
    return off;
  }, [reload]);

  const phase = session?.phase;
  const active = session?.status === 'active';
  const canType = active && ['narrate', 'followup', 'deep'].includes(phase ?? '');
  const streaming = streamText !== null;
  const refining = phase === 'refining';

  const runOp = (p: Promise<OpResult>): void => {
    void p.then((r) => {
      // R4：任何 IPC 拒绝/失败都清理本地加载状态（不得残留"请求中"阻止再次发送）
      if (!r.ok) setStreamText(null);
      if (!r.ok && r.error === 'budget_paused') {
        setBanner({
          tone: 'fail',
          text: `本月预算已用完（${r.spendCny} / ${r.limitCny} 元），已暂停模型调用；可在设置中调整。`,
        });
      } else if (!r.ok && r.error !== 'busy') {
        setBanner({ tone: 'fail', text: r.detail ?? opErrorText(r.error) });
      }
      void reload();
    });
  };

  const send = (): void => {
    const text = input.trim();
    if (!text || !sessionId || streaming || refining) return;
    setInput('');
    setBanner(null);
    setStreamText('');
    runOp(window.zhixing.session.send({ sessionId, content: text }));
  };

  const messages = snap?.messages ?? [];

  return (
    <PageShell
      title="对话"
      description="复盘以对话进行：应用会追问细节，也会在你选择结束时收束成日报。"
    >
      {!loaded && <p className="text-[16px] text-ink-3">正在读取…</p>}

      {loaded && !session && (
        <section className="rounded-card border border-line bg-surface px-7 py-9">
          <h2 className="text-[17px] font-medium text-ink">还没有进行中的对话</h2>
          <p className="mt-2 max-w-[560px] text-[16px] leading-relaxed text-ink-3">
            从「今晚复盘」开始一段对话。过程中随时可以跳过追问、深入某个点，或直接结束。
          </p>
          <button
            type="button"
            onClick={() => {
              void window.zhixing.session.startChat().then((r) => {
                if (r.ok) {
                  void reload();
                }
              });
            }}
            className="mt-5 rounded-control bg-accent px-5 py-2.5 text-[15px] font-medium text-accent-contrast transition-colors duration-150 hover:opacity-90"
          >
            在这里开始复盘
          </button>
        </section>
      )}

      {session && (
        <div className="flex flex-col gap-4">
          {/* 阶段与状态条 */}
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="rounded-full bg-bg-sunk px-3 py-1 text-[13px] text-ink-2">
              阶段：{PHASE_LABEL[phase ?? 'closed']}
            </span>
            {session.kind === 'short' && (
              <span className="rounded-full bg-bg-sunk px-3 py-1 text-[13px] text-ink-2">简短模式</span>
            )}
            {refining && <StatusChip tone="progress" label="提炼中" hint="正在生成日报" />}
            {phase === 'refine_failed' && <StatusChip tone="fail" label="提炼失败" hint="草稿保留，可重试" />}
            {session.followupUsed > 0 && phase !== 'closed' && (
              <span className="text-[13px] text-ink-3">追问已用 {session.followupUsed}/2</span>
            )}
          </div>

          {banner && (
            <div
              className={`rounded-card border px-5 py-4 text-[15px] leading-relaxed ${
                banner.tone === 'ok'
                  ? 'border-ok/30 bg-ok-soft text-ink'
                  : banner.tone === 'progress'
                    ? 'border-amber/30 bg-amber-soft text-ink'
                    : 'border-hot/30 bg-hot-soft text-ink'
              }`}
              role="status"
            >
              {banner.text}
              {banner.retryable && sessionId && (
                <button
                  type="button"
                  onClick={() => runOp(window.zhixing.session.retry({ sessionId }))}
                  className="ml-3 rounded-control border border-line-strong bg-surface px-3 py-1 text-[14px] text-ink-2 hover:text-ink"
                >
                  重试
                </button>
              )}
            </div>
          )}

          {/* 消息流 */}
          <div className="flex flex-col gap-3" aria-live="polite">
            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} />
            ))}
            {streaming && (
              <AssistantBubble
                content={(() => {
                  // S9：流式期间不展示未经处理的追问（完整回复经主进程规范化后再显示）
                  const cut = streamText.indexOf('【追问】');
                  const shown = cut >= 0 ? streamText.slice(0, cut) : streamText;
                  return shown + (cut >= 0 ? '\\n（追问已收起：每次只问一个）' : '') + (streamText.endsWith('\n') || streamText === '' ? '▍' : '');
                })()}
                stateLabel="请求中"
              />
            )}
            {messages.length === 0 && !streaming && (
              <p className="rounded-card border border-dashed border-line px-6 py-8 text-center text-[15px] text-ink-3">
                从一句话开始：今天做了什么、放下了什么？（Win+H 可语音听写）
              </p>
            )}
          </div>

          {/* 结束区 / 确认区 */}
          {active && (phase === 'refine_failed' || !refining) && (
            <div className="rounded-card border border-line bg-surface px-6 py-5">
              {phase === 'refine_failed' ? (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => sessionId && runOp(window.zhixing.session.end({ sessionId }))}
                    className="rounded-control bg-accent px-4 py-2 text-[14px] font-medium text-accent-contrast hover:opacity-90"
                  >
                    重试生成日报
                  </button>
                  <span className="text-[14px] text-ink-3">上次提炼未成功；对话内容都已保存。</span>
                </div>
              ) : confirmEnd ? (
                <div>
                  <p className="text-[15px] text-ink">
                    确认结束并生成日报？点击结束不代表接受建议；只有你明确同意的行动才会登记。
                  </p>
                  <div className="mt-3 flex gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmEnd(false);
                        if (sessionId) runOp(window.zhixing.session.end({ sessionId }));
                      }}
                      className="rounded-control bg-accent px-4 py-2 text-[14px] font-medium text-accent-contrast hover:opacity-90"
                    >
                      确认结束
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmEnd(false)}
                      className="rounded-control border border-line-strong px-4 py-2 text-[14px] text-ink-2 hover:text-ink"
                    >
                      再聊聊
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setConfirmEnd(true)}
                    className="rounded-control border border-line-strong bg-bg-sunk px-4 py-2 text-[14px] text-ink-2 hover:text-ink"
                  >
                    结束复盘
                  </button>
                  {phase === 'followup' && sessionId && (
                    <button
                      type="button"
                      onClick={() => runOp(window.zhixing.session.skip({ sessionId }))}
                      disabled={streaming}
                      className="rounded-control border border-line-strong px-4 py-2 text-[14px] text-ink-2 hover:text-ink disabled:opacity-50"
                    >
                      跳过追问
                    </button>
                  )}
                  {['narrate', 'followup', 'wrapup'].includes(phase ?? '') && sessionId && (
                    <button
                      type="button"
                      onClick={() => runOp(window.zhixing.session.deep({ sessionId }))}
                      disabled={streaming}
                      className="rounded-control border border-line-strong px-4 py-2 text-[14px] text-ink-2 hover:text-ink disabled:opacity-50"
                    >
                      深入对话
                    </button>
                  )}
                  {session.status === 'closed' && snap?.latestReport && (
                    <button
                      type="button"
                      onClick={() => navigate('records')}
                      className="text-[14px] text-accent underline-offset-4 hover:underline"
                    >
                      查看日报 →
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {session.status === 'closed' && (
            <div className="flex flex-wrap items-center gap-4">
              <p className="text-[15px] text-ink-3">
                今天的复盘已结束{snap?.latestReport ? `，日报修订 v${snap.latestReport.rev}` : ''}。
                漏一天没关系，明天直接继续。
              </p>
              {snap?.latestReport && (
                <button
                  type="button"
                  onClick={() => navigate('records')}
                  className="text-[14px] text-accent underline-offset-4 hover:underline"
                >
                  查看日报 →
                </button>
              )}
            </div>
          )}

          {/* 输入区 */}
          {canType && !confirmEnd && (
            <div className="rounded-card border border-line bg-surface p-4">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                rows={3}
                maxLength={20000}
                disabled={streaming || refining}
                placeholder={
                  phase === 'narrate'
                    ? '讲讲今天：做了什么、放下了什么、感觉如何…（Enter 发送，Shift+Enter 换行）'
                    : phase === 'deep'
                      ? '深入聊聊…（Enter 发送）'
                      : '回答追问，或点击「跳过追问」…（Enter 发送）'
                }
                className="w-full resize-none rounded-control border border-line-strong bg-bg px-4 py-3 text-[16px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none disabled:opacity-60"
              />
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[13px] text-ink-3">
                  Enter 发送 · Shift+Enter 换行 · 可粘贴、可 Win+H 听写
                </span>
                <button
                  type="button"
                  onClick={send}
                  disabled={!input.trim() || streaming || refining}
                  className="rounded-control bg-accent px-5 py-2 text-[15px] font-medium text-accent-contrast transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {streaming ? '回复中…' : '发送'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

function opErrorText(error?: string): string {
  switch (error) {
    case 'busy': return '上一个请求还在进行中。';
    case 'phase': return '当前阶段不能进行该操作。';
    case 'closed': return '会话已结束。';
    case 'invalid': return '输入为空或格式不合法。';
    default: return '操作失败，请重试。';
  }
}

function MessageBubble({ m }: { m: MessageRecord }) {
  if (m.kind === 'skip-note') {
    return (
      <p className="text-center text-[13.5px] text-ink-3" role="note">
        —— {m.content.replaceAll('（', '').replaceAll('）', '')} ——
      </p>
    );
  }
  if (m.role === 'user') {
    return (
      <div className="ml-auto max-w-[80%] rounded-card rounded-br-control border border-line-strong bg-bg-sunk px-5 py-3.5">
        <p className="whitespace-pre-wrap text-[16px] leading-relaxed text-ink">{m.content}</p>
      </div>
    );
  }
  return <AssistantBubble content={m.content} stateLabel={STATE_LABEL[m.state]} />;
}

function AssistantBubble({ content, stateLabel }: { content: string; stateLabel: string }) {
  // 提取【追问】行单独展示（提示词约定：最后一行以【追问】开头）
  const lines = content.split('\n');
  let followup: string | null = null;
  const qi = lines.findIndex((l) => l.trim().startsWith('【追问】'));
  if (qi >= 0) {
    followup = lines.slice(qi).join('\n').replace(/^\s*【追问】\s*/, '');
    lines.splice(qi);
  }
  return (
    <div className="max-w-[88%] rounded-card rounded-bl-control border border-line bg-surface px-5 py-4">
      <p className="whitespace-pre-wrap text-[16px] leading-relaxed text-ink">{lines.join('\n').trim()}</p>
      {followup && (
        <p className="mt-3 rounded-control border-l-2 border-accent bg-accent-soft px-4 py-2.5 text-[16px] text-accent-ink">
          {followup}
        </p>
      )}
      <p className="mt-2 text-right text-[12.5px] text-ink-3">{stateLabel}</p>
    </div>
  );
}
