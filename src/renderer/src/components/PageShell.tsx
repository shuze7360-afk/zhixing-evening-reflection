import type { ReactNode } from 'react';

interface PageShellProps {
  title: string;
  description: string;
  children?: ReactNode;
}

export function PageShell({ title, description, children }: PageShellProps) {
  return (
    <div className="mx-auto w-full max-w-[880px] px-10 py-9">
      <header className="mb-7">
        <h1 className="text-[22px] font-semibold text-ink">{title}</h1>
        <p className="mt-1 text-[15px] text-ink-3">{description}</p>
      </header>
      {children}
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  detail: string;
  /** 后续任务接入的说明，如实标注当前不可用 */
  pending?: string;
  children?: ReactNode;
}

export function EmptyState({ title, detail, pending, children }: EmptyStateProps) {
  return (
    <section className="rounded-card border border-line bg-surface px-7 py-9">
      <h2 className="text-[17px] font-medium text-ink">{title}</h2>
      <p className="mt-2 max-w-[560px] text-[15px] leading-relaxed text-ink-3">
        {detail}
      </p>
      {pending && (
        <p className="mt-4 inline-block rounded-control bg-bg-sunk px-3 py-1.5 text-[13px] text-ink-3">
          {pending}
        </p>
      )}
      {children}
    </section>
  );
}

interface StatusChipProps {
  tone: 'ok' | 'progress' | 'fail';
  label: string;
  hint: string;
}

/** 状态规范示意（docs/UI_SPEC.md §5）：区分不同环节，不合并成一个"成功" */
export function StatusChip({ tone, label, hint }: StatusChipProps) {
  const toneClass =
    tone === 'ok'
      ? 'bg-ok-soft text-ok'
      : tone === 'progress'
        ? 'bg-amber-soft text-amber'
        : 'bg-hot-soft text-hot';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-medium ${toneClass}`}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
      <span className="font-normal opacity-75">{hint}</span>
    </span>
  );
}
