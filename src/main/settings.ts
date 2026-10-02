// 设置存取：数据库为事实来源；API Key 经注入的 Cryptor（Electron safeStorage）加密存储（D-003）。
// 本模块不直接 import electron：Cryptor 由入口注入，便于离线测试；getPublicSettings 永不返回密钥。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { get, nowIso, run, type Db } from './db';
import { DEFAULT_BUDGET_CNY, PLACEHOLDER_PRICE_CNY_PER_MTOK, BIGMODEL_BASE_URL, BIGMODEL_MODEL } from '../shared/config';

export interface Cryptor {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string | null;
}

export interface SettingsData {
  apiKeyEnc: string | null;
  obsidianDir: string | null;
  /** 多模型兼容：API 基础地址（OpenAI 兼容接口，空 = 默认 BigModel）与模型名（空 = 默认模型） */
  apiBaseUrl: string | null;
  model: string | null;
  budgetMonthlyCny: number;
  priceInCnyPerMtok: number | null;   // null = 未核实 → 使用占位价（D-016）
  priceOutCnyPerMtok: number | null;
  priceCheckedAt: string | null;
  reminderEnabled: boolean;
  reminderStart: string;
  reminderEnd: string;
}

/** D-013 默认导出目录（可在设置修改）。公开版：从当前用户主目录推导，不硬编码任何个人路径。 */
export const DEFAULT_OBSIDIAN_DIR = join(homedir(), 'Documents', 'Obsidian Vault', '个人成长', '晚间复盘');
/** D-010 默认提醒窗口 */
export const DEFAULT_REMINDER_START = '21:30';
export const DEFAULT_REMINDER_END = '23:00';

function readAll(db: Db): SettingsData {
  const rows = db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: string): number | null => {
    const v = map.get(k);
    if (v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    apiKeyEnc: map.get('api_key_enc') ?? null,
    obsidianDir: map.get('obsidian_dir') ?? null,
    apiBaseUrl: map.get('api_base_url') ?? null,
    model: map.get('model') ?? null,
    budgetMonthlyCny: num('budget_monthly_cny') ?? DEFAULT_BUDGET_CNY,
    priceInCnyPerMtok: num('price_in_cny_per_mtok'),
    priceOutCnyPerMtok: num('price_out_cny_per_mtok'),
    priceCheckedAt: map.get('price_checked_at') ?? null,
    reminderEnabled: map.get('reminder_enabled') !== '0',
    reminderStart: map.get('reminder_start') ?? DEFAULT_REMINDER_START,
    reminderEnd: map.get('reminder_end') ?? DEFAULT_REMINDER_END,
  };
}

export function getSettings(db: Db): SettingsData {
  return readAll(db);
}

/** 多模型兼容：解析生效的接口地址与模型名。任何 OpenAI 兼容接口（BigModel、DeepSeek、
 *  Moonshot、OpenAI、本地 Ollama 等）配置 Base URL + 模型名即可使用；空值回落默认 BigModel。 */
export function resolveApiConfig(db: Db): { chatUrl: string; model: string } {
  const s = readAll(db);
  const base = (s.apiBaseUrl ?? '').trim().replace(/\/+$/, '') || BIGMODEL_BASE_URL;
  const model = (s.model ?? '').trim() || BIGMODEL_MODEL;
  return { chatUrl: `${base}/chat/completions`, model };
}

/** 渲染进程可见的设置视图：永远不含 API Key 的明文或密文 */
export function getPublicSettings(db: Db, monthlySpendCny: number, dataDir: string) {
  const s = readAll(db);
  const priceIsPlaceholder = s.priceInCnyPerMtok === null || s.priceOutCnyPerMtok === null;
  return {
    hasApiKey: s.apiKeyEnc !== null,
    apiBaseUrl: s.apiBaseUrl ?? BIGMODEL_BASE_URL,
    model: s.model ?? BIGMODEL_MODEL,
    obsidianDir: s.obsidianDir ?? DEFAULT_OBSIDIAN_DIR,
    budgetMonthlyCny: s.budgetMonthlyCny,
    monthlySpendCny,
    priceInCnyPerMtok: s.priceInCnyPerMtok ?? PLACEHOLDER_PRICE_CNY_PER_MTOK,
    priceOutCnyPerMtok: s.priceOutCnyPerMtok ?? PLACEHOLDER_PRICE_CNY_PER_MTOK,
    priceIsPlaceholder,
    priceCheckedAt: s.priceCheckedAt,
    dataDir,
  };
}

function put(db: Db, key: string, value: string): void {
  run(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    nowIso(),
  );
}

export interface PlainSettingsPatch {
  obsidianDir?: string;
  apiBaseUrl?: string;
  model?: string;
  budgetMonthlyCny?: number;
  priceInCnyPerMtok?: number | null;
  priceOutCnyPerMtok?: number | null;
  priceCheckedAt?: string | null;
  reminderEnabled?: boolean;
  reminderStart?: string;
  reminderEnd?: string;
}

export function setPlainSettings(db: Db, patch: PlainSettingsPatch): void {
  if (patch.obsidianDir !== undefined) put(db, 'obsidian_dir', patch.obsidianDir);
  if (patch.apiBaseUrl !== undefined) put(db, 'api_base_url', patch.apiBaseUrl);
  if (patch.model !== undefined) put(db, 'model', patch.model);
  if (patch.budgetMonthlyCny !== undefined) put(db, 'budget_monthly_cny', String(patch.budgetMonthlyCny));
  if (patch.priceInCnyPerMtok !== undefined) {
    put(db, 'price_in_cny_per_mtok', patch.priceInCnyPerMtok === null ? '' : String(patch.priceInCnyPerMtok));
  }
  if (patch.priceOutCnyPerMtok !== undefined) {
    put(db, 'price_out_cny_per_mtok', patch.priceOutCnyPerMtok === null ? '' : String(patch.priceOutCnyPerMtok));
  }
  if (patch.priceCheckedAt !== undefined) {
    put(db, 'price_checked_at', patch.priceCheckedAt ?? '');
  }
  if (patch.reminderEnabled !== undefined) {
    put(db, 'reminder_enabled', patch.reminderEnabled ? '1' : '0');
  }
  if (patch.reminderStart !== undefined) put(db, 'reminder_start', patch.reminderStart);
  if (patch.reminderEnd !== undefined) put(db, 'reminder_end', patch.reminderEnd);
}

/** 写入 API Key：仅经 Cryptor 加密后入库；系统安全存储不可用时明确失败 */
export function setApiKey(db: Db, cryptor: Cryptor, plainKey: string): void {
  if (!cryptor.available()) {
    throw new Error('系统安全存储（safeStorage）不可用，无法加密保存 API Key。已拒绝以明文存储。');
  }
  put(db, 'api_key_enc', cryptor.encrypt(plainKey));
  // 防御：确保不存在旧明文残留键
  run(db, `DELETE FROM settings WHERE key = 'api_key_plain'`);
}

export function getApiKey(db: Db, cryptor: Cryptor): string | null {
  const enc = readAll(db).apiKeyEnc;
  if (!enc) return null;
  return cryptor.decrypt(enc);
}
