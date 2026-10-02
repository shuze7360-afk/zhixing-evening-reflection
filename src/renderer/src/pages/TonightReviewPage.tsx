import { useEffect, useState } from 'react';
import { PageShell, StatusChip } from '../components/PageShell';
import { useNav } from '../components/nav';
import type { AppInfo, TodaySnapshot } from '../../../shared/ipc';

export function TonightReviewPage() {
  const navigate = useNav();
  const [snap, setSnap] = useState<TodaySnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [shortMode, setShortMode] = useState(false);

  useEffect(() => {
    window.zhixing.session
      .getToday()
      .then(setSnap)
      .catch(() => setSnap(null))
      .finally(() => setLoaded(true));
  }, []);

  const session = snap?.session ?? null;
  const active = session?.status === 'active';
  const hasReport = snap?.latestReport != null;

  return (
    <PageShell
      title="今晚复盘"
      description="每天 3—5 分钟：记下今天的取舍，看清背后的道理，留下一个可验证的小改变。"
    >
      {active && (
        <section className="rounded-card border border-accent/30 bg-accent-soft px-7 py-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-[17px] font-medium text-ink">今晚的复盘进行中</h2>
              <p className="mt-1 text-[16px] text-ink-2">
                有 {snap?.messages.length ?? 0} 条记录 · 阶段：{session && PHASE_TEXT[session.phase]}
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate('dialog')}
              className="rounded-control bg-accent px-5 py-2.5 text-[15px] font-medium text-accent-contrast transition-colors duration-150 hover:opacity-90"
            >
              继续对话
            </button>
          </div>
        </section>
      )}

      {!active && (
        <section className="rounded-card border border-line bg-surface px-7 py-8">
          <h2 className="text-[17px] font-medium text-ink">
            {loaded ? (hasReport ? '今天已经记录过了' : '今晚还没有复盘') : '正在读取…'}
          </h2>
          <p className="mt-2 max-w-[560px] text-[16px] leading-relaxed text-ink-3">
            晚上抽几分钟，从一个问题开始：今天做了什么、放下了什么？应用会陪你把当天的选择想清楚，
            结束时自动整理成日报并保存到 Obsidian。随时可以跳过追问或直接结束。
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!loaded}
              onClick={() => {
                void window.zhixing.session.startChat().then((r) => {
                  if (r.ok) navigate('dialog');
                });
              }}
              className="rounded-control bg-accent px-5 py-2.5 text-[15px] font-medium text-accent-contrast transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              开始今晚复盘
            </button>
            <button
              type="button"
              disabled={!loaded}
              onClick={() => setShortMode((v) => !v)}
              aria-expanded={shortMode}
              className="rounded-control border border-line-strong bg-bg-sunk px-4 py-2.5 text-[15px] text-ink-2 transition-colors duration-150 hover:text-ink disabled:opacity-50"
            >
              今天只记一句
            </button>
          </div>
          {hasReport && (
            <button
              type="button"
              onClick={() => navigate('records')}
              className="mt-4 block text-[14px] text-accent underline-offset-4 hover:underline"
            >
              查看今天的日报 →
            </button>
          )}
        </section>
      )}

      {shortMode && (
        <ShortModeCard
          onDone={() => {
            setShortMode(false);
            navigate('records');
          }}
        />
      )}

      {!active && (
        <p className="mt-4 text-[14px] text-ink-3">
          漏记了也没关系：第二天直接继续，不补作业、不清零。
        </p>
      )}

      <section className="mt-6 rounded-card border border-line bg-surface px-7 py-5">
        <div className="text-[14px] text-ink-3">本阶段状态规范（避免用一个「成功」掩盖不同环节）：</div>
        <div className="mt-3 flex flex-wrap gap-2.5">
          <StatusChip tone="ok" label="已保存" hint="消息已落库" />
          <StatusChip tone="progress" label="提炼中" hint="正在生成日报" />
          <StatusChip tone="fail" label="提炼失败" hint="草稿保留，可重试" />
        </div>
      </section>

      <VersionFooter />
    </PageShell>
  );
}

const PHASE_TEXT: Record<string, string> = {
  narrate: '自由讲述',
  followup: '追问中',
  wrapup: '收束反馈',
  deep: '深入探讨',
  refining: '提炼日报中',
  refine_failed: '提炼失败（可重试）',
  closed: '已结束',
};

function ShortModeCard({ onDone }: { onDone: () => void }) {
  const [content, setContent] = useState('');
  const [mood, setMood] = useState<string>('还行');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = (): void => {
    if (!content.trim() || busy) return;
    setBusy(true);
    setErr(null);
    window.zhixing.session
      .startShort({ content: content.trim(), mood })
      .then((r) => {
        if (r.ok) onDone();
        else setErr(r.detail ?? r.error ?? '保存失败');
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="mt-5 rounded-card border border-line bg-surface px-7 py-6">
      <h2 className="text-[17px] font-medium text-ink">只记一句</h2>
      <p className="mt-1.5 text-[16px] text-ink-3">完成比完整更重要。只记一句话，不发起 AI 反馈。</p>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={2}
        maxLength={500}
        placeholder="今天的一句话…（Win+H 可语音听写）"
        className="mt-4 w-full resize-none rounded-control border border-line-strong bg-bg px-4 py-3 text-[16px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="情绪标记">
        {['还行', '一般', '很累'].map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mood === m}
            onClick={() => setMood(m)}
            className={`rounded-full px-3.5 py-1.5 text-[14px] transition-colors duration-150 ${
              mood === m
                ? 'bg-accent-soft font-medium text-accent-ink'
                : 'bg-bg-sunk text-ink-3 hover:text-ink'
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      {err && <p className="mt-3 text-[14px] text-hot">{err}</p>}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!content.trim() || busy}
          className="rounded-control bg-accent px-5 py-2.5 text-[15px] font-medium text-accent-contrast transition-colors duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? '保存中…' : '保存并生成日报'}
        </button>
      </div>
    </section>
  );
}

function VersionFooter() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    window.zhixing.appInfo().then(setInfo).catch(() => setInfo(null));
  }, []);
  return (
    <p className="mt-6 text-[12.5px] text-ink-3">
      {info
        ? `${info.name} · v${info.version} · Electron ${info.electron} · ${info.platform}`
        : '应用信息不可用（IPC 未就绪）'}
    </p>
  );
}
