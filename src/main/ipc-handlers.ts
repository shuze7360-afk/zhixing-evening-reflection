// IPC handler 注册：主进程对白名单通道的唯一实现处。
// 安全纪律：任何 handler 都不得返回 API Key 明文/密文；错误详情不包含密钥；消息全文不出主进程。
import { existsSync } from 'node:fs';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type {
  AppEvent,
  AppInfo,
  IpcChannel,
  ModelEvent,
  OpResult,
  PublicSettings,
  SettingsPatch,
  StartShortArgs,
  TestConnectionResult,
  TodaySnapshot,
} from '../shared/ipc';
import { ExperimentCreateSchema, PrincipleDraftSchema, SettingsPatchSchema } from '../shared/schemas';
import { testConnectionBudgeted, type FetchFn } from './bigmodel';
import { effectiveSpendCny } from './budget';
import type { Db } from './db';
import { get } from './db';
import { getApiKey, getPublicSettings, getSettings, setApiKey, setPlainSettings, type Cryptor } from './settings';
import { addDraftCard, listPrinciples, setCardEnabled, updateDraftCard } from './principles';
import { activeExperiment, addObservation, concludeExperiment, createExperiment, listExperiments, startExperimentDraft } from './experiments';
import { acceptReportAction, confirmReportFeeling, listRecentReports, retryReportExport, reportsByDate, viewReports } from './reports';
import { listPeriodReports, type createPeriodService } from './periodic';
import { backupDatabase, requestRestore } from './backup';
import { dialog as electronDialog } from 'electron';
import { bindTaskTargetAndExport, doneTaskPathMismatch, ensurePeriodExportTask, resolveVaultPath } from './obsidian';
import type { createSessionService } from './session';

export interface HandlerDeps {
  db: Db;
  cryptor: Cryptor;
  appVersion: string;
  dataDir: string;
  session: ReturnType<typeof createSessionService>;
  period: ReturnType<typeof createPeriodService>;
  fetchFn?: FetchFn;
}

/** 事件仅发给本应用窗口 */
function makeNotifier(channel: 'model:event' | 'app:event') {
  return (event: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, event);
    }
  };
}

function ok<T extends object>(extra?: T): { ok: true } & T {
  return { ok: true, ...(extra ?? {}) } as { ok: true } & T;
}

function fail(error: NonNullable<OpResult['error']>, detail?: string): OpResult {
  return { ok: false, error, detail };
}

export function registerIpcHandlers(deps: HandlerDeps): void {
  const notifyModel = makeNotifier('model:event') as (e: ModelEvent) => void;
  const notifyApp = makeNotifier('app:event') as (e: AppEvent) => void;

  ipcMain.handle('app:info' satisfies IpcChannel, (): AppInfo => ({
    name: '知行（evening-reflection）',
    version: deps.appVersion,
    electron: process.versions.electron ?? '-',
    platform: process.platform,
  }));

  ipcMain.handle('settings:get' satisfies IpcChannel, (): PublicSettings => {
    return getPublicSettings(deps.db, effectiveSpendCny(deps.db), deps.dataDir) as PublicSettings;
  });

  ipcMain.handle('settings:set' satisfies IpcChannel, (_e, patch: SettingsPatch): OpResult => {
    const parsed = SettingsPatchSchema.safeParse(patch ?? {});
    if (!parsed.success) {
      return fail('invalid', parsed.error.issues.map((i) => i.path.join('.')).join('；'));
    }
    try {
      if (parsed.data.apiKey !== undefined) {
        setApiKey(deps.db, deps.cryptor, parsed.data.apiKey);
      }
      const { apiKey: _apiKeyOneWay, ...rest } = parsed.data;
      void _apiKeyOneWay;
      setPlainSettings(deps.db, rest);
      return ok();
    } catch (err) {
      return fail('internal', (err as Error).message);
    }
  });

  ipcMain.handle('settings:testConnection' satisfies IpcChannel, async (): Promise<TestConnectionResult> => {
    const apiKey = getApiKey(deps.db, deps.cryptor);
    if (!apiKey) {
      return { ok: false, errorClass: 'auth', message: '尚未配置 API Key：请先在上方保存 Key。', elapsedMs: 0 };
    }
    // B3：统一走带预算闸的连接测试（事务化预占，超预算零网络调用）
    const s = getPublicSettings(deps.db, effectiveSpendCny(deps.db), '');
    return testConnectionBudgeted(deps.db, {
      apiKey,
      fetchFn: deps.fetchFn,
      price: { inCnyPerMtok: s.priceInCnyPerMtok, outCnyPerMtok: s.priceOutCnyPerMtok },
      limitCny: s.budgetMonthlyCny,
    });
  });

  ipcMain.handle('dialog:chooseDirectory' satisfies IpcChannel, async (): Promise<string | null> => {
    const win = BrowserWindow.getAllWindows()[0];
    const r = await dialog.showOpenDialog(win, {
      title: '选择 Obsidian 导出目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  ipcMain.handle('session:getToday' satisfies IpcChannel, (): TodaySnapshot => deps.session.getToday());

  ipcMain.handle('session:start' satisfies IpcChannel, (_e, args?: { mode: string } & Partial<StartShortArgs>) => {
    if (args?.mode === 'short') {
      return deps.session.startShort({ content: args.content ?? '', mood: args.mood });
    }
    return deps.session.startChat();
  });

  ipcMain.handle('session:send' satisfies IpcChannel, (_e, args: { sessionId: string; content: string }): Promise<OpResult> =>
    deps.session.send(args));

  ipcMain.handle('session:retry' satisfies IpcChannel, (_e, args: { sessionId: string }): Promise<OpResult> =>
    deps.session.retry(args));

  ipcMain.handle('session:skip' satisfies IpcChannel, (_e, args: { sessionId: string }): Promise<OpResult> =>
    deps.session.skipFollowup(args.sessionId));

  ipcMain.handle('session:deep' satisfies IpcChannel, (_e, args: { sessionId: string }): Promise<OpResult> =>
    deps.session.enterDeep(args.sessionId));

  ipcMain.handle('session:end' satisfies IpcChannel, (_e, args: { sessionId: string }): Promise<OpResult> =>
    deps.session.endSession(args.sessionId));

  ipcMain.handle('report:getByDate' satisfies IpcChannel, (_e, args: { date: string }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args?.date ?? '')) return fail('invalid');
    return ok({ reports: viewReports(reportsByDate(deps.db, args.date), deps.db) });
  });

  ipcMain.handle('report:list' satisfies IpcChannel, (_e, args?: { limit?: number }) => {
    const limit = Math.min(Math.max(Number(args?.limit ?? 60), 1), 200);
    return ok({ reports: viewReports(listRecentReports(deps.db, limit), deps.db) });
  });

  ipcMain.handle('report:acceptAction' satisfies IpcChannel, (_e, args: { reportId: string; index: number }) => {
    const r = acceptReportAction(deps.db, {
      reportId: args?.reportId ?? '',
      index: args?.index ?? -1,
      appVersion: deps.appVersion,
      notify: notifyApp,
    });
    return r.ok ? ok({ report: r.report }) : fail(r.error, r.detail ?? '无法确认该行动候选');
  });

  ipcMain.handle('report:exportRetry' satisfies IpcChannel, async (_e, args: { taskId: string }) => {
    if (!args?.taskId) return fail('invalid');
    const task = get<{ ref_id: string }>(deps.db, `SELECT ref_id FROM export_tasks WHERE id = ?`, args.taskId);
    const r = await retryReportExport(deps.db, args.taskId, deps.appVersion);
    notifyApp({
      type: 'export', taskId: args.taskId, refId: task?.ref_id ?? '',
      status: r.status, targetRel: r.targetRel, error: r.error,
    });
    return r.ok ? ok({ status: r.status, targetRel: r.targetRel }) : fail('internal', r.error);
  });

  ipcMain.handle('export:openLocation' satisfies IpcChannel, (_e, args: { taskId: string }): OpResult => {
    // G5：定位必须使用**任务持久绑定的目录**与实际发布路径——
    // 全局 A / 任务 B、全局未配置、设置后来改变、A 有同名文件，都不得定位错文件。
    const task = get<{ target_rel: string; vault_dir: string | null; status: string; content_hash: string }>(
      deps.db,
      `SELECT target_rel, vault_dir, status, content_hash FROM export_tasks WHERE id = ?`,
      args?.taskId,
    );
    if (!task) return fail('not_found', '导出任务不存在');
    // H3：UNRESOLVED（历史 NULL 迁移标记）= 未知历史目标——明确拒绝，绝不静默回退
    // 当前全局目录（否则会打开全局目录里的同名无关文件）。
    if (task.vault_dir === 'UNRESOLVED') {
      return fail('invalid', '该任务的目标目录未确认：请先通过「选择目标目录并导出」确认目标');
    }
    // L2：done 任务的记录路径上存在内容不符的文件（历史遗留 done/旧路径指向用户
    // 笔记/旧报告）——定位前不得把错误路径当作已验证报告；引导用户先「重新核验导出」。
    // 文件缺失或目录未配置仍走既有的 not_found/未配置分支。
    if (doneTaskPathMismatch(deps.db, task)) {
      return fail('invalid', '该任务的记录路径与内容不一致：请先在列表中「重新核验导出」恢复后再定位');
    }
    const bound = task.vault_dir ?? null;
    // G5：用原始设置值（getSettings.obsidianDir 可为 null），不能吃 DEFAULT_OBSIDIAN_DIR 兜底
    const vault = bound ?? getSettings(deps.db).obsidianDir;
    if (!vault) return fail('invalid', '未配置 Obsidian 导出目录，且任务未绑定目标目录');
    const full = resolveVaultPath(vault, task.target_rel);
    if (!full) return fail('invalid', '导出路径异常');
    if (!existsSync(full)) {
      return fail('not_found', '文件不存在（导出目录可能已移动或被删除）');
    }
    shell.showItemInFolder(full);
    return ok();
  });

  // ---- 思想库（ER-003）----
  ipcMain.handle('principles:list' satisfies IpcChannel, () => ok({ cards: listPrinciples(deps.db) }));

  ipcMain.handle('principles:setEnabled' satisfies IpcChannel, (_e, args: { id: string; enabled: boolean }) => {
    if (!args?.id || typeof args.enabled !== 'boolean') return fail('invalid');
    // N7：启用校验失败必须如实返回（不得把失败报成成功）
    const r = setCardEnabled(deps.db, args.id, args.enabled);
    return r.ok ? ok() : fail('invalid', r.error);
  });

  ipcMain.handle('principles:updateDraft' satisfies IpcChannel, (_e, args: { id: string; position?: string; interpretation?: string; boundary?: string; sourceUrl?: string }) => {
    if (!args?.id) return fail('invalid');
    // S7：草稿补全入口——真实透传校验结果
    const r = updateDraftCard(deps.db, args.id, {
      position: args.position, interpretation: args.interpretation, boundary: args.boundary, sourceUrl: args.sourceUrl,
    });
    return r.ok ? ok() : fail('invalid', r.error);
  });

  ipcMain.handle('principles:addDraft' satisfies IpcChannel, (_e, args: { text: string; sourceUrl?: string; origin: 'paste' | 'file' | 'suggestion' }) => {
    const parsed = PrincipleDraftSchema.safeParse(args ?? {});
    if (!parsed.success) return fail('invalid', '内容为空、过长或链接不合法');
    return ok({ card: addDraftCard(deps.db, parsed.data) });
  });

  // ---- 小实验（ER-003）----
  ipcMain.handle('experiments:list' satisfies IpcChannel, () => ok({ experiments: listExperiments(deps.db) }));

  ipcMain.handle('experiments:active' satisfies IpcChannel, () => ok({ experiment: activeExperiment(deps.db) }));

  ipcMain.handle('experiments:create' satisfies IpcChannel, (_e, args: unknown) => {
    const parsed = ExperimentCreateSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return fail('invalid', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；'));
    }
    const r = createExperiment(deps.db, parsed.data);
    return r.ok ? ok({ experiment: r.experiment }) : fail(r.error, r.detail);
  });

  ipcMain.handle('experiments:start' satisfies IpcChannel, (_e, args: { id: string }) => {
    if (!args?.id) return fail('invalid');
    const r = startExperimentDraft(deps.db, args.id);
    return r.ok ? ok({ experiment: r.experiment }) : fail(r.error === 'active_exists' ? 'phase' : 'invalid', r.detail);
  });

  ipcMain.handle('experiments:observe' satisfies IpcChannel, (_e, args: { id: string; text: string }) => {
    if (!args?.id) return fail('invalid');
    const r = addObservation(deps.db, args.id, args.text ?? '');
    return r.ok ? ok() : fail('invalid', r.detail);
  });

  ipcMain.handle('experiments:conclude' satisfies IpcChannel, (_e, args: { id: string; outcome: string; conclusion: string }) => {
    if (!args?.id) return fail('invalid');
    const r = concludeExperiment(deps.db, args.id, { outcome: args.outcome ?? '', conclusion: args.conclusion ?? '' });
    return r.ok ? ok() : fail('invalid', r.detail);
  });

  // ---- 周期报告（ER-004）----
  ipcMain.handle('report:confirmFeeling' satisfies IpcChannel, (_e, args: { reportId: string; item: string }) => {
    if (!args?.reportId || !args?.item?.trim()) return fail('invalid');
    const r = confirmReportFeeling(deps.db, {
      reportId: args.reportId,
      item: args.item,
      appVersion: deps.appVersion,
      notify: notifyApp,
    });
    return r.ok ? ok({ report: r.report }) : fail(r.error, r.detail ?? '该项不在待核对列表中');
  });

  // ---- H2：已发布周期报告缺导出任务时的零模型补排程入口 ----
  ipcMain.handle('reports:periodExportRetry' satisfies IpcChannel, async (_e, args: { reportId: string }) => {
    if (!args?.reportId) return fail('invalid');
    let result;
    try {
      result = await ensurePeriodExportTask(deps.db, args.reportId, deps.appVersion);
    } catch (err) {
      return fail('internal', (err as Error).message);
    }
    notifyApp({ type: 'export', taskId: '', refId: args.reportId, status: result.status, targetRel: result.targetRel, error: result.error });
    return result.ok ? ok({ status: result.status, targetRel: result.targetRel }) : fail('internal', result.error);
  });

  // ---- F7：UNRESOLVED 导出任务的解决入口——用户选择目标目录 → 绑定到任务 → 零模型重试导出 ----
  ipcMain.handle('export:bindTargetAndRetry' satisfies IpcChannel, async (_e, args: { taskId: string; vaultDir: string | null }) => {
    if (!args?.taskId) return fail('invalid');
    const r = await bindTaskTargetAndExport(deps.db, args.taskId, args.vaultDir ?? null, deps.appVersion);
    return r.ok ? ok({ result: r }) : fail('invalid', r.error);
  });

  ipcMain.handle('reports:periodList' satisfies IpcChannel, () => ok({ reports: listPeriodReports(deps.db) }));

  ipcMain.handle('reports:periodGenerate' satisfies IpcChannel, (_e, args: { kind: 'weekly' | 'monthly' | 'yearly'; start: string; end: string; label?: string }) => {
    if (!args?.kind || !args.start || !args.end) return fail('invalid');
    return deps.period.generate({ kind: args.kind, start: args.start, end: args.end, label: args.label ?? '' }).then((r) =>
      r.ok
        ? ok({ report: r.report })
        : fail(r.error === 'budget_paused' ? 'budget_paused' : 'internal', r.detail),
    );
  });

  // ---- 备份与恢复（ER-005）----
  ipcMain.handle('data:backup' satisfies IpcChannel, (_e, args: { targetDir: string }) => {
    if (!args?.targetDir) return fail('invalid');
    const r = backupDatabase(deps.db, args.targetDir, deps.dataDir);
    return r.ok ? ok({ file: r.file }) : fail('internal', r.error);
  });

  ipcMain.handle('data:restore' satisfies IpcChannel, async () => {
    const win = BrowserWindow.getAllWindows()[0];
    const picked = await electronDialog.showOpenDialog(win, {
      title: '选择备份文件（zhixing-backup-….db）',
      properties: ['openFile'],
      filters: [{ name: '知行备份', extensions: ['db'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return ok({ requested: false });
    const check = requestRestore(deps.dataDir, picked.filePaths[0]);
    if (!check.ok) return fail('invalid', check.error);
    return ok({ requested: true, counts: check.counts });
  });

  // ---- 外部链接（仅 https，经系统浏览器；渲染层导航已被禁用）----
  ipcMain.handle('app:openExternal' satisfies IpcChannel, (_e, args: { url: string }): OpResult => {
    try {
      const u = new URL(args?.url ?? '');
      if (u.protocol !== 'https:') return fail('invalid', '仅允许 https 链接');
      void shell.openExternal(u.toString());
      return ok();
    } catch {
      return fail('invalid', '链接不合法');
    }
  });
}
