import { useEffect, useState } from 'react';
import { PageShell } from '../components/PageShell';
import type { PrincipleRecord } from '../../../shared/ipc';

export function PrinciplesPage() {
  const [cards, setCards] = useState<PrincipleRecord[] | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [origin, setOrigin] = useState<'paste' | 'suggestion'>('paste');
  const [msg, setMsg] = useState<string | null>(null);

  const reload = (): void => {
    window.zhixing.principles
      .list()
      .then((r) => setCards(r.cards ?? []))
      .catch(() => setCards([]));
  };
  useEffect(reload, []);

  const submitImport = (): void => {
    window.zhixing.principles
      .addDraft({ text, sourceUrl: url || undefined, origin })
      .then((r) => {
        if (r.ok) {
          setText('');
          setUrl('');
          setMsg('已存为草稿：补充定位与边界说明后，确认启用即可参与复盘反馈。');
          reload();
        } else {
          setMsg(r.detail ?? '导入失败');
        }
      });
  };

  return (
    <PageShell
      title="思想库"
      description="原则卡 = 原文摘录 + 出处定位 + 中文解读 + 适用边界。引用可溯源到来源快照；解读不是原文。"
    >
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setImportOpen((v) => !v)}
          aria-expanded={importOpen}
          className="rounded-control border border-line-strong px-4 py-2 text-[14px] text-ink-2 hover:text-ink"
        >
          {importOpen ? '收起导入' : '导入摘录 / 建议'}
        </button>
      </div>

      {importOpen && (
        <section className="mt-4 rounded-card border border-line bg-surface px-7 py-6">
          <h2 className="text-[16px] font-medium text-ink">新增原则卡（草稿）</h2>
          <p className="mt-1 text-[14px] text-ink-3">
            支持粘贴摘录、Markdown/TXT 内容或个人建议；保存后默认不启用，需你确认。
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={1000}
            placeholder="粘贴英文/中文摘录，或写下你自己的原则建议…"
            className="mt-3 w-full resize-none rounded-control border border-line-strong bg-bg px-4 py-3 text-[16px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="来源链接（可选，https://…）"
              className="min-w-[260px] flex-1 rounded-control border border-line-strong bg-bg px-4 py-2 text-[15px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
            />
            <select
              value={origin}
              onChange={(e) => setOrigin(e.target.value as 'paste' | 'suggestion')}
              className="rounded-control border border-line-strong bg-bg px-3 py-2 text-[15px] text-ink"
              aria-label="来源类型"
            >
              <option value="paste">摘录粘贴</option>
              <option value="suggestion">个人建议</option>
            </select>
            <button
              type="button"
              disabled={!text.trim()}
              onClick={submitImport}
              className="rounded-control bg-accent px-4 py-2 text-[15px] font-medium text-accent-contrast hover:opacity-90 disabled:opacity-50"
            >
              保存草稿
            </button>
          </div>
          {msg && <p className="mt-3 text-[14px] text-ink-2">{msg}</p>}
        </section>
      )}

      <div className="mt-6 flex flex-col gap-4">
        {cards === null && <p className="text-[16px] text-ink-3">正在读取…</p>}
        {cards?.length === 0 && (
          <p className="rounded-card border border-dashed border-line px-6 py-8 text-center text-[15px] text-ink-3">
            思想库为空：启动时会自动导入《纳瓦尔宝典》首批原则（默认未启用）。
          </p>
        )}
        {cards?.map((c) => (
          <article key={c.id} className={`rounded-card border px-7 py-6 ${c.enabled ? 'border-line bg-surface' : 'border-dashed border-line bg-bg-sunk'}`}>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="rounded-full bg-bg-sunk px-2.5 py-0.5 text-[12.5px] text-ink-2">{c.position}</span>
              {!c.enabled && (
                <span className="rounded-full bg-amber-soft px-2.5 py-0.5 text-[12.5px] text-amber">未启用</span>
              )}
              <button
                type="button"
                onClick={() => {
                  const next = !c.enabled;
                  if (next && !window.confirm('确认启用该原则卡？启用后会参与复盘反馈的参考。')) return;
                  void window.zhixing.principles.setEnabled({ id: c.id, enabled: next }).then((r) => {
                    // T5：校验失败透传 detail（不得固定显示 invalid）
                    if (!r.ok) setMsg(r.detail ?? r.error ?? '启用失败');
                    reload();
                  });
                }}
                className="ml-auto rounded-control border border-line-strong px-3 py-1 text-[13px] text-ink-2 hover:text-ink"
              >
                {c.enabled ? '停用' : '确认启用'}
              </button>
            </div>
            <blockquote className="mt-3 border-l-2 border-accent/40 pl-4 text-[16px] italic leading-relaxed text-ink">
              {c.quoteOriginal}
            </blockquote>
            {c.interpretation && (
              <p className="mt-3 text-[16px] leading-relaxed text-ink-2">
                <span className="mr-1.5 rounded bg-accent-soft px-1.5 py-0.5 text-[12.5px] text-accent-ink">解读</span>
                {c.interpretation}
              </p>
            )}
            {c.boundary && (
              <p className="mt-2 text-[15px] leading-relaxed text-ink-3">
                <span className="mr-1.5 font-medium">适用边界：</span>
                {c.boundary}
              </p>
            )}
            {/* T5：未启用卡始终可编辑（填了也保留入口），失败后仍可修改 */}
            {!c.enabled && (
              <DraftCompleteForm id={c.id} defaultPosition={c.position} defaultInterpretation={c.interpretation} defaultBoundary={c.boundary} defaultSourceUrl={c.sourceUrl ?? ''} onDone={reload} />
            )}

            <div className="mt-3 flex flex-wrap items-center gap-4 text-[13px] text-ink-3">
              {c.sourceUrl && (
                <button
                  type="button"
                  onClick={() => void window.zhixing.app.openExternal({ url: c.sourceUrl! })}
                  className="underline-offset-4 hover:text-ink hover:underline"
                >
                  查看原文出处 ↗
                </button>
              )}
              {c.snapshotId && <span>来源快照：{c.snapshotId}</span>}
            </div>
          </article>
        ))}
      </div>
    </PageShell>
  );
}

function DraftCompleteForm({
  id, defaultPosition, defaultInterpretation, defaultBoundary, defaultSourceUrl, onDone,
}: {
  id: string; defaultPosition: string; defaultInterpretation: string; defaultBoundary: string;
  defaultSourceUrl: string; onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(defaultPosition.includes('待补充') ? '' : defaultPosition);
  const [interpretation, setInterpretation] = useState(defaultInterpretation);
  const [boundary, setBoundary] = useState(defaultBoundary);
  const [sourceUrl, setSourceUrl] = useState(defaultSourceUrl);
  const [msg, setMsg] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 block text-[13px] text-accent underline-offset-4 hover:underline"
      >
        补全定位 / 解读 / 边界（启用前必填）
      </button>
    );
  }
  return (
    <div className="mt-3 space-y-2 rounded-control border border-line bg-bg px-4 py-3">
      <input
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        placeholder="来源定位（如：某书·章节·小节，或 [个人建议]）"
        className="w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
      />
      <input
        value={interpretation}
        onChange={(e) => setInterpretation(e.target.value)}
        placeholder="中文解读（标记为解读，不是原文）"
        className="w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
      />
      <input
        value={boundary}
        onChange={(e) => setBoundary(e.target.value)}
        placeholder="适用边界"
        className="w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
      />
      <div className="flex items-center gap-3">
        <input
          value={sourceUrl}
          onChange={(e) => setSourceUrl(e.target.value)}
          placeholder="来源链接（个人建议可不填）"
          className="min-w-[220px] flex-1 rounded-control border border-line-strong bg-surface px-3 py-2 text-[15px] text-ink focus:border-accent focus:outline-none"
        />
        <button
          type="button"
          onClick={() => {
            void window.zhixing.principles
              .updateDraft({ id, position, interpretation, boundary, sourceUrl: sourceUrl || undefined })
              .then((r) => {
                if (r.ok) {
                  setMsg('已保存。');
                  onDone();
                } else {
                  setMsg(r.detail ?? r.error ?? '保存失败');
                }
              });
          }}
          disabled={!position.trim()}
          className="rounded-control bg-accent px-3 py-1.5 text-[14px] font-medium text-accent-contrast hover:opacity-90 disabled:opacity-50"
        >
          保存补全
        </button>
        {msg && <span className="text-[13px] text-ink-2">{msg}</span>}
      </div>
    </div>
  );
}
