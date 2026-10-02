import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initTheme } from './theme';
import './styles/app.css';

initTheme();
// 截图与测试用的就绪标记（主进程视觉检查矩阵等待该值）
(window as unknown as Record<string, unknown>).__zhixingReady = true;
(window as unknown as {
  __zhixingApplyTheme?: (t: string) => void;
}).__zhixingApplyTheme = (t: string) => {
  document.documentElement.setAttribute(
    'data-theme',
    t === 'dark' ? 'dark' : 'light',
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
