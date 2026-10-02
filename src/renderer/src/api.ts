// 渲染进程的展示辅助：状态/阶段中文标签、错误提示映射。
import type { ErrorClass, RequestState, SessionPhase } from '../../shared/ipc';

export const PHASE_LABEL: Record<SessionPhase, string> = {
  narrate: '自由讲述',
  followup: '追问中',
  wrapup: '收束反馈',
  deep: '深入探讨',
  refining: '提炼日报中',
  refine_failed: '提炼失败（可重试）',
  closed: '已结束',
};

export const STATE_LABEL: Record<RequestState, string> = {
  unsent: '未发送',
  running: '请求中',
  unknown: '结果不明',
  verified: '已保存',
  failed: '失败',
};

export function stateTone(s: RequestState): 'ok' | 'progress' | 'fail' | 'neutral' {
  if (s === 'verified') return 'ok';
  if (s === 'running' || s === 'unsent') return 'progress';
  if (s === 'unknown' || s === 'failed') return 'fail';
  return 'neutral';
}

/** 测试连接/请求失败后的处理提示（不提供自动重试；重试一律由用户点击触发） */
export const ERROR_HINT: Partial<Record<ErrorClass, string>> = {
  auth: '检查 API Key 是否正确（此前作废的旧 Key 不能再使用）。',
  balance: '前往 BigModel 控制台充值后重试。',
  rate_limit: '触发限流：稍等片刻再试。',
  model: '模型不可用：确认 BigModel 账户可使用 glm-5.3-flash。',
  bad_request: '请求内容被接口拒绝，可尝试调整表述。',
  server: 'BigModel 服务端错误，稍后再试。',
  timeout: '请求超时（120 秒），未自动重发；可点击重试。',
  network: '网络不通：检查网络后重试。',
  input_limit: '输入超过 24KB 上限：请结束复盘生成日报，或明天开新对话。',
  budget: '本月预算已用完：可在设置中调整月度预算（本地记录不受影响）。',
};
