// 预加载脚本：在 contextIsolation + sandbox 下仅暴露白名单内的最小 API。
// 渲染进程拿不到 ipcRenderer 本体，也无法调用白名单之外的通道或事件。
import { contextBridge, ipcRenderer } from 'electron';
import {
  isEventChannel,
  isIpcChannel,
  type AppEvent,
  type AppInfo,
  type EventChannel,
  type ExperimentRecord,
  type IpcChannel,
  type ModelEvent,
  type OpResult,
  type PeriodReportRecord,
  type PrincipleRecord,
  type PublicSettings,
  type ReportRecord,
  type SettingsPatch,
  type StartShortArgs,
  type TestConnectionResult,
  type TodaySnapshot,
} from '../shared/ipc';

type Unsubscribe = () => void;

function invoke<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  if (!isIpcChannel(channel)) {
    return Promise.reject(new Error(`非白名单 IPC 通道: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

function subscribe<T>(channel: EventChannel, cb: (event: T) => void): Unsubscribe {
  if (!isEventChannel(channel)) {
    throw new Error(`非白名单事件通道: ${channel}`);
  }
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener as never);
  return () => {
    ipcRenderer.removeListener(channel, listener as never);
  };
}

const api = {
  appInfo: (): Promise<AppInfo> => invoke<AppInfo>('app:info'),

  settings: {
    get: (): Promise<PublicSettings> => invoke<PublicSettings>('settings:get'),
    set: (patch: SettingsPatch): Promise<{ ok: boolean; error?: string; detail?: string }> =>
      invoke('settings:set', patch),
    testConnection: (): Promise<TestConnectionResult> => invoke<TestConnectionResult>('settings:testConnection'),
  },

  dialog: {
    chooseDirectory: (): Promise<string | null> => invoke<string | null>('dialog:chooseDirectory'),
  },

  session: {
    getToday: (): Promise<TodaySnapshot> => invoke<TodaySnapshot>('session:getToday'),
    startChat: (): Promise<{ ok: boolean; error?: string; snapshot?: TodaySnapshot }> =>
      invoke('session:start', { mode: 'chat' }),
    startShort: (
      args: StartShortArgs,
    ): Promise<{ ok: boolean; error?: string; detail?: string; snapshot?: TodaySnapshot }> =>
      invoke('session:start', { mode: 'short', ...args }),
    send: (args: { sessionId: string; content: string }): Promise<OpResult> =>
      invoke<OpResult>('session:send', args),
    retry: (args: { sessionId: string }): Promise<OpResult> => invoke<OpResult>('session:retry', args),
    skip: (args: { sessionId: string }): Promise<OpResult> => invoke<OpResult>('session:skip', args),
    deep: (args: { sessionId: string }): Promise<OpResult> => invoke<OpResult>('session:deep', args),
    end: (args: { sessionId: string }): Promise<OpResult> => invoke<OpResult>('session:end', args),
  },

  report: {
    getByDate: (args: { date: string }): Promise<{ ok: boolean; reports?: unknown[]; error?: string }> =>
      invoke('report:getByDate', args),
    list: (args?: { limit?: number }): Promise<{ ok: boolean; reports?: unknown[]; error?: string }> =>
      invoke('report:list', args ?? {}),
    exportRetry: (args: { taskId: string }): Promise<OpResult> =>
      invoke<OpResult>('report:exportRetry', args),
    acceptAction: (
      args: { reportId: string; index: number },
    ): Promise<{ ok: boolean; report?: ReportRecord; error?: string }> =>
      invoke('report:acceptAction', args),
    confirmFeeling: (
      args: { reportId: string; item: string },
    ): Promise<{ ok: boolean; report?: ReportRecord; error?: string }> =>
      invoke('report:confirmFeeling', args),
    periodList: (): Promise<{ ok: boolean; reports?: PeriodReportRecord[] }> =>
      invoke('reports:periodList'),
    periodGenerate: (
      args: { kind: 'weekly' | 'monthly' | 'yearly'; start: string; end: string; label?: string },
    ): Promise<{ ok: boolean; report?: PeriodReportRecord; error?: string; detail?: string }> =>
      invoke('reports:periodGenerate', args),
    periodExportRetry: (args: { reportId: string }): Promise<OpResult> =>
      invoke<OpResult>('reports:periodExportRetry', args),
  },

  export: {
    openLocation: (args: { taskId: string }): Promise<{ ok: boolean; error?: string; detail?: string }> =>
      invoke('export:openLocation', args),
    bindTargetAndRetry: (args: { taskId: string; vaultDir: string | null }): Promise<OpResult> =>
      invoke<OpResult>('export:bindTargetAndRetry', args),
  },

  principles: {
    list: (): Promise<{ ok: boolean; cards?: PrincipleRecord[] }> => invoke('principles:list'),
    setEnabled: (args: { id: string; enabled: boolean }): Promise<{ ok: boolean; error?: string; detail?: string }> =>
      invoke('principles:setEnabled', args),
    addDraft: (
      args: { text: string; sourceUrl?: string; origin: 'paste' | 'file' | 'suggestion' },
    ): Promise<{ ok: boolean; card?: PrincipleRecord; error?: string; detail?: string }> =>
      invoke('principles:addDraft', args),
    updateDraft: (
      args: { id: string; position?: string; interpretation?: string; boundary?: string; sourceUrl?: string },
    ): Promise<{ ok: boolean; error?: string; detail?: string }> =>
      invoke('principles:updateDraft', args),
  },

  experiments: {
    list: (): Promise<{ ok: boolean; experiments?: ExperimentRecord[] }> => invoke('experiments:list'),
    active: (): Promise<{ ok: boolean; experiment?: ExperimentRecord | null }> => invoke('experiments:active'),
    create: (
      args: import('../shared/schemas').ExperimentCreateInput,
    ): Promise<{ ok: boolean; experiment?: ExperimentRecord; error?: string; detail?: string }> =>
      invoke('experiments:create', args),
    start: (args: { id: string }): Promise<{ ok: boolean; experiment?: ExperimentRecord; error?: string; detail?: string }> =>
      invoke('experiments:start', args),
    observe: (args: { id: string; text: string }): Promise<{ ok: boolean; detail?: string }> =>
      invoke('experiments:observe', args),
    conclude: (args: { id: string; outcome: string; conclusion: string }): Promise<{ ok: boolean; detail?: string }> =>
      invoke('experiments:conclude', args),
  },

  app: {
    openExternal: (args: { url: string }): Promise<{ ok: boolean; error?: string }> =>
      invoke('app:openExternal', args),
  },

  data: {
    backup: (args: { targetDir: string }): Promise<{ ok: boolean; file?: string; error?: string; detail?: string }> =>
      invoke('data:backup', args),
    restore: (): Promise<{ ok: boolean; requested?: boolean; counts?: Record<string, number>; error?: string; detail?: string }> =>
      invoke('data:restore'),
  },

  onModelEvent: (cb: (event: ModelEvent) => void): Unsubscribe =>
    subscribe<ModelEvent>('model:event', cb),
  onAppEvent: (cb: (event: AppEvent) => void): Unsubscribe =>
    subscribe<AppEvent>('app:event', cb),
};

contextBridge.exposeInMainWorld('zhixing', api);

export type ZhixingApi = typeof api;
