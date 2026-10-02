// 页面间导航的轻量上下文（App 注入，页面消费）。
import { createContext, useContext } from 'react';
import type { PageId } from './Sidebar';

export const NavContext = createContext<(page: PageId) => void>(() => {});

export function useNav(): (page: PageId) => void {
  return useContext(NavContext);
}
