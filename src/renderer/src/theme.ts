// 主题偏好：浅色 / 深色 / 跟随系统。data-theme 只反映最终生效值。
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'zhixing.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function loadPreference(): ThemePreference {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

export function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref !== 'system') return pref;
  return media.matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);
  return resolved;
}

export function savePreference(pref: ThemePreference): ResolvedTheme {
  if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
  else localStorage.setItem(STORAGE_KEY, pref);
  return applyTheme(pref);
}

// 跟随系统模式下，系统切换主题时实时生效
media.addEventListener('change', () => {
  if (loadPreference() === 'system') applyTheme('system');
});

export function initTheme(): void {
  const url = new URL(window.location.href);
  const forced = url.searchParams.get('theme');
  if (forced === 'light' || forced === 'dark') {
    applyTheme(forced);
    return;
  }
  applyTheme(loadPreference());
}
