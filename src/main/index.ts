// 主进程入口：窗口与安全边界 + ER-002/003/004 能力接线（数据库、设置、模型、会话、导出、思想库、提醒、周期报告）。
import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, powerMonitor, safeStorage, session, Tray } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from './db';
import type { AppEvent } from '../shared/ipc';
import { recoverPendingExports } from './obsidian';
import { registerIpcHandlers } from './ipc-handlers';
import { seedPrinciples } from './principles';
import { completedPeriods, createPeriodService, listPeriodReports } from './periodic';
import { decideReminder, recordAttempt } from './reminders';
import { createSessionService } from './session';
import { evaluateStartupRestore } from './backup';
import { recoverInterrupted } from './session';
import { getApiKey, getSettings, type Cryptor } from './settings';

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
// 视觉检查矩阵用：ZHIXING_CAPTURE=<输出目录> 时启动后逐组截图并退出（仅开发用途）
const CAPTURE_DIR = process.env.ZHIXING_CAPTURE;
const CAPTURE_SPEC = process.env.ZHIXING_CAPTURE_SPEC ?? '1366x768:light,1366x768:dark';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let trayExplained = false;
let appDb: Db | null = null;
void appDb;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1104,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#faf9f6',
    title: '知行 — 晚间复盘',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_SERVER_URL && url.startsWith(DEV_SERVER_URL);
    if (!allowed) event.preventDefault();
  });
  // 关闭窗口 → 进入托盘（首次解释）；显式退出（托盘菜单）才真正停止后台。
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
      if (!trayExplained) {
        trayExplained = true;
        if (Notification.isSupported()) {
          new Notification({
            title: '知行仍在后台运行',
            body: '会按设置的提醒窗口提示你复盘；要彻底退出，请用托盘图标菜单中的「退出」。',
          }).show();
        }
      }
    }
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    // 生产加载使用 file://；此处只允许加载本应用自身的入口文件
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

// 渲染进程不加载任何远程内容；生产模式下补上 CSP 响应头作为纵深防御。
// 开发模式由 Vite 本地服务提供页面（仅监听 127.0.0.1），注入式内联脚本与 CSP 冲突，故不加头。
function registerContentSecurityPolicy(): void {
  if (DEV_SERVER_URL) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        ],
      },
    });
  });
}

function setupServices(): void {
  const userDataDir = app.getPath('userData');
  // B1：恢复失败绝不允许静默以空库继续（ ER-R01 第二轮）
  const restoreOutcome = evaluateStartupRestore(userDataDir);
  const dbPath = join(userDataDir, 'zhixing.db');
  if (restoreOutcome.action === 'abort') {
    const msg = `数据库恢复未能完成：${restoreOutcome.error ?? '未知原因'}
为避免生成空数据库，应用即将退出。请检查备份文件后重试恢复。`;
    console.error('[restore]', msg);
    if (!CAPTURE_DIR) {
      dialog.showErrorBox('知行 — 恢复失败', msg);
    }
    app.exit(1);
    return;
  }
  if (restoreOutcome.from) {
    console.log(`[restore] 已从 ${restoreOutcome.from} 恢复数据库（原库留档为 zhixing.db.before-restore）`);
  }
  if (restoreOutcome.action === 'continue' && restoreOutcome.error) {
    // 失败但已回滚：数据安全，但必须明确告知，不得无声
    console.error('[restore]', restoreOutcome.error);
    if (!CAPTURE_DIR && Notification.isSupported()) {
      new Notification({ title: '知行 — 恢复未完成', body: restoreOutcome.error }).show();
    }
  }
  const db = openDb(dbPath);
  appDb = db;
  // B2：启动中断恢复（ER-R01 第二轮）——遗留 running 请求记为结果不明，refining 会话转为可重试
  recoverInterrupted(db);

  const cryptor: Cryptor = {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (encoded) => {
      try {
        return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
      } catch {
        return null;
      }
    },
  };

  // 提示词基础目录：开发=项目根/resources；打包=process.resourcesPath/resources（ER-005 配置 extraResources）
  const promptsBaseDir = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources');

  const notifyApp = (event: AppEvent): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('app:event', event);
    }
  };

  const sessionService = createSessionService({
    db,
    promptsBaseDir,
    appVersion: app.getVersion(),
    cryptor,
    notifyModel: (event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('model:event', event);
      }
    },
    notifyApp,
  });

  const periodService = createPeriodService({
    db,
    promptsBaseDir,
    appVersion: app.getVersion(),
    getApiKey: () => getApiKey(db, cryptor),
    notifyApp,
  });

  registerIpcHandlers({
    db,
    cryptor,
    appVersion: app.getVersion(),
    dataDir: userDataDir,
    session: sessionService,
    period: periodService,
  });

  // 启动恢复：上次未完成的导出任务（幂等，先核对已有结果）
  // J2：recoverPendingExports 为 async 且内部绝不拒绝；显式挂接 catch 双保险
  recoverPendingExports(db, app.getVersion()).catch(() => undefined);
  // 思想库首批原则幂等种子化（用户确认后才启用）
  const seeded = seedPrinciples(db, promptsBaseDir);
  if (seeded.inserted > 0) {
    console.log(`[principles] 首批原则已入库 ${seeded.inserted} 张（默认未启用，待确认）`);
  }
  // 提醒：启动即检查（睡眠恢复后再查，持久记录去重，绝不重复催促）
  startReminderLoop(db);
  // 周期报告：启动 + 每小时检查（周期结束后应用运行且预算允许时生成；空周期不生成）
  void checkPeriodicReports(db, periodService, promptsBaseDir, app.getVersion());
  setInterval(() => void checkPeriodicReports(db, periodService, promptsBaseDir, app.getVersion()), 60 * 60_000);
}

/** 托盘：关闭窗口常驻；显式退出停止后台 */
function createTray(): void {
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('知行 — 晚间复盘');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => mainWindow?.show() },
      { type: 'separator' },
      {
        label: '退出（停止后台提醒）',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

/** 提醒循环：每分钟 + 睡眠恢复时检查；窗口内、当天未尝试且未记录时通知一次 */
function startReminderLoop(db: Db): void {
  const tick = (): void => {
    try {
      const s = getSettings(db);
      const decision = decideReminder(db, new Date(), {
        enabled: s.reminderEnabled,
        start: s.reminderStart,
        end: s.reminderEnd,
      });
      if (decision.action === 'notify') {
        // 先落"已尝试"，再弹通知：任何崩溃都不会导致重复催促
        recordAttempt(db, new Date(), 'notification');
        if (Notification.isSupported()) {
          new Notification({
            title: '知行 · 晚间复盘',
            body: '今晚花 3—5 分钟，记下今天的取舍。（每天只提醒一次）',
          }).show();
        }
      }
    } catch (err) {
      console.error('[reminder]', (err as Error).message);
    }
  };
  tick();
  setInterval(tick, 60_000);
  powerMonitor.on('resume', () => tick());
  powerMonitor.on('unlock-screen', () => tick());
}

/** 周期报告检查：缺失或过时的已结束周期（重新）生成；空周期/无预算/无 Key 时安静跳过 */
async function checkPeriodicReports(
  db: Db,
  periodService: ReturnType<typeof createPeriodService>,
  promptsBaseDir: string,
  appVersion: string,
): Promise<void> {
  try {
    const existing = listPeriodReports(db);
    for (const p of completedPeriods(new Date())) {
      const existingForPeriod = existing.filter(
        (r) => r.kind === p.kind && r.periodStart === p.start && r.periodEnd === p.end,
      );
      // R8-c：已有报告（即使过时）→ 不由后台自动重生成；用户可在成长回顾页显式触发
      if (existingForPeriod.length > 0) continue;
      const r = await periodService.generate(p);
      if (!r.ok && r.error !== 'empty' && r.error !== 'budget_paused' && r.error !== 'no_key') {
        console.error(`[periodic] ${p.label}: ${r.detail ?? r.error}`);
      }
      void promptsBaseDir;
      void appVersion;
    }
  } catch (err) {
    console.error('[periodic]', (err as Error).message);
  }
}

app.on('before-quit', () => {
  quitting = true; // app.quit()（含截图模式与托盘退出）允许窗口真正关闭
});

// R9：单实例锁——第二个实例只聚焦已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  setupServices();
  registerContentSecurityPolicy();
  if (!CAPTURE_DIR) createTray();
  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });

  if (CAPTURE_DIR) {
    void runCaptureSequence(mainWindow);
  }
});

app.on('window-all-closed', () => {
  // 托盘常驻行为属 ER-004；当前阶段关闭窗口即退出。
  app.quit();
});

/** 视觉检查矩阵：按「宽x高:主题」清单调整窗口、切换主题、截图、退出。 */
async function runCaptureSequence(win: BrowserWindow): Promise<void> {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(CAPTURE_DIR!, { recursive: true });
  await new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve());
  });
  await win.webContents.executeJavaScript('window.__zhixingReady').catch(() => undefined);
  for (const spec of CAPTURE_SPEC.split(',')) {
    // 规格：宽x高[@缩放]:主题[:导航序号]，如 1366x768@1.25:dark:3
    const [size, theme, navIndex] = spec.trim().split(':');
    const [w, h, zoom] = size.split(/x|@/).map(Number);
    win.setContentSize(w, h);
    win.webContents.setZoomFactor(Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
    await win.webContents.executeJavaScript(
      `window.__zhixingApplyTheme(${JSON.stringify(theme)}); true`,
    );
    if (navIndex !== undefined) {
      await win.webContents.executeJavaScript(
        `(document.querySelector('aside nav')?.querySelectorAll('button')[${Number(navIndex)}])?.click(); true`,
      );
    }
    await new Promise((r) => setTimeout(r, 400));
    const image = await win.webContents.capturePage();
    const page = navIndex !== undefined ? `-p${navIndex}` : '';
    const file = join(CAPTURE_DIR!, `zhixing-${w}x${h}${zoom ? `@${zoom}` : ''}-${theme}${page}.png`);
    writeFileSync(file, image.toPNG());
    console.log(`[capture] ${file}`);
  }
  app.quit();
}
