// 渲染进程全局类型：window.zhixing（preload 暴露的白名单 API）。
import type { ZhixingApi } from '../../preload/index';

declare global {
  interface Window {
    zhixing: ZhixingApi;
  }
}

export {};
