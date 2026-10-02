// 跨进程共享的常量：模型接入、限制与版本。主/预加载/渲染三方一致引用。
// BigModel 配置权威来源：docs/DECISIONS.md D-001；价格机制见 D-016。

export const BIGMODEL_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
export const BIGMODEL_CHAT_URL = `${BIGMODEL_BASE_URL}/chat/completions`;
export const BIGMODEL_MODEL = 'glm-5.3-flash'; // 默认模型；可在设置中改用任何 OpenAI 兼容接口的模型名

/** 默认请求超时（可取消），见 D-001 */
export const REQUEST_TIMEOUT_MS = 120_000;
/** 单次输出上限（tokens） */
export const MAX_OUTPUT_TOKENS = 8192;
/** 单次输入正文序列化后上限（字节），见 ARCHITECTURE.md §5 */
export const MAX_INPUT_BYTES = 24 * 1024;

export const PROMPT_VERSION = 'v1';

/** 月度预算默认值（元），见 D-012 */
export const DEFAULT_BUDGET_CNY = 20;
/** 占位价（元/百万 tokens）：未核实实际单价前的保守预占单价，见 D-016 */
export const PLACEHOLDER_PRICE_CNY_PER_MTOK = 8;

/** 各类请求的输出预占估算上限（tokens）：反馈对话 / JSON 提炼 / 连接测试 */
export const OUTPUT_ESTIMATE: Record<'chat' | 'refine' | 'fix' | 'test', number> = {
  chat: 1200,
  refine: MAX_OUTPUT_TOKENS,
  fix: MAX_OUTPUT_TOKENS,
  test: 32,
};

/** 日报单字段/数组规模上限（与 Zod schema 一致的展示约束） */
export const REPORT_LIMITS = {
  coverage: 500,
  itemText: 400,
  itemCount: 20,
  ideaCount: 10,
  actionCount: 5,
};
