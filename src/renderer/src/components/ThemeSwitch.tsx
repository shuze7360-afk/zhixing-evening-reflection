import { useState } from 'react';
import {
  loadPreference,
  savePreference,
  type ThemePreference,
} from '../theme';

const OPTIONS: Array<{ key: ThemePreference; label: string }> = [
  { key: 'dark', label: '深色' },
  { key: 'system', label: '系统' },
  { key: 'light', label: '浅色' },
];

/** 三档外观切换（深色 / 跟随系统 / 浅色）。 */
export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePreference>(() => loadPreference());
  const current = pref;

  const choose = (key: ThemePreference) => {
    setPref(key);
    savePreference(key);
  };

  return (
    <div>
      <div id="theme-switch-label" className="mb-2 text-[13px] text-ink-3">
        外观
      </div>
      <div
        role="radiogroup"
        aria-labelledby="theme-switch-label"
        className="grid grid-cols-3 rounded-full border border-line bg-bg-sunk p-[3px]"
      >
        {OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={current === o.key}
            onClick={() => choose(o.key)}
            className={`rounded-full px-2 py-1 text-[12.5px] transition-colors duration-150 ${
              current === o.key
                ? 'bg-surface font-medium text-ink shadow-[0_1px_2px_rgba(0,0,0,0.12)]'
                : 'text-ink-3 hover:text-ink-2'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
