import type { ReactNode } from 'react';

export type PageId =
  | 'tonight'
  | 'dialog'
  | 'records'
  | 'experiments'
  | 'principles'
  | 'growth'
  | 'settings';

interface NavItem {
  id: PageId;
  label: string;
  icon: ReactNode;
}

function icon(path: ReactNode): ReactNode {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

const NAV: NavItem[] = [
  { id: 'tonight', label: '今晚复盘', icon: icon(<><path d="M20 12.5A7.5 7.5 0 0 1 11.5 4a7.5 7.5 0 1 0 8.5 8.5Z" /><path d="M17 3.5v3M15.5 5h3" /></>) },
  { id: 'dialog', label: '对话', icon: icon(<path d="M21 12a8 8 0 0 1-8 8H4l2.3-3A8 8 0 1 1 21 12Z" />) },
  { id: 'records', label: '我的记录', icon: icon(<><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></>) },
  { id: 'experiments', label: '小实验', icon: icon(<><path d="M10 3h4M11 3v6l-5.5 9.2A2 2 0 0 0 7.2 21h9.6a2 2 0 0 0 1.7-2.8L13 9V3" /><path d="M8.5 15h7" /></>) },
  { id: 'principles', label: '思想库', icon: icon(<><path d="M12 3a6.5 6.5 0 0 1 4 11.6c-.7.6-1 1.4-1 2.4h-6c0-1-.3-1.8-1-2.4A6.5 6.5 0 0 1 12 3Z" /><path d="M9.5 20h5M10.5 22h3" /></>) },
  { id: 'growth', label: '成长回顾', icon: icon(<><path d="M4 19h16" /><path d="M5 15l4-5 3.5 3L17 7l2 2" /></>) },
  { id: 'settings', label: '设置', icon: icon(<><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95A7 7 0 0 0 14 5.1L13.6 2.6h-4L9.2 5.1a7 7 0 0 0-2.5 1.44l-2.36-.95-2 3.46 2 1.55a7 7 0 0 0 0 2.8l-2 1.55 2 3.46 2.36-.95A7 7 0 0 0 9.2 18.9l.4 2.5h4l.4-2.5a7 7 0 0 0 2.5-1.44l2.36.95 2-3.46-2-1.55A7 7 0 0 0 19 12Z" /></>) },
];

interface SidebarProps {
  active: PageId;
  onNavigate: (id: PageId) => void;
  footer: ReactNode;
}

export function Sidebar({ active, onNavigate, footer }: SidebarProps) {
  return (
    <aside
      className="flex w-[232px] shrink-0 flex-col border-r border-line bg-sidebar"
      aria-label="主导航"
    >
      <div className="px-5 pt-6 pb-2">
        <div className="text-[19px] font-semibold tracking-wide text-ink">知行</div>
        <div className="mt-0.5 text-[13px] text-ink-3">晚间复盘 · 知行合一</div>
      </div>
      <nav className="flex-1 px-3 py-3">
        <ul className="flex flex-col gap-1">
          {NAV.map((item) => {
            const isActive = item.id === active;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`flex w-full items-center gap-3 rounded-control px-3 py-2 text-left text-[15px] transition-colors duration-150 ${
                    isActive
                      ? 'bg-accent-soft font-medium text-accent-ink'
                      : 'text-ink-2 hover:bg-bg-sunk hover:text-ink'
                  }`}
                >
                  <span className={isActive ? 'text-accent' : 'text-ink-3'}>
                    {item.icon}
                  </span>
                  {item.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="border-t border-line px-5 py-4">{footer}</div>
    </aside>
  );
}
