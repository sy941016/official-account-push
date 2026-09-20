import 'dotenv/config';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

/** 项目根目录（config/ 的上一级），用于锚定所有相对路径，避免依赖启动时的 cwd */
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 把可能是相对路径的配置项统一解析为绝对路径 */
const fromRoot = (p) => (p.startsWith('/') ? p : join(projectRoot, p));

const int = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/** 环境变量里的布尔值。未设置/空串走 fallback；其余按 0/false/no/off 判否 */
const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

export const config = {
  // AI
  ai: {
    provider: process.env.AI_PROVIDER || 'claude',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    doubaoKey: process.env.DOUBAO_API_KEY || '',
    doubaoModel: process.env.DOUBAO_MODEL || 'doubao-pro-1-5',
    doubaoBaseUrl: process.env.DOUBAO_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    // 单次 LLM 请求超时（毫秒）与失败重试次数
    requestTimeoutMs: int(process.env.AI_REQUEST_TIMEOUT_MS, 180_000),
    maxRetries: int(process.env.AI_MAX_RETRIES, 3),
    // 采样惩罚：压低高频"保险用词"的重复率，是降低文本可预测性最直接的两个旋钮。
    // Claude 协议不支持这两个参数，只有 openai / doubao 会带上。
    frequencyPenalty: num(process.env.AI_FREQUENCY_PENALTY, 0.4),
    presencePenalty: num(process.env.AI_PRESENCE_PENALTY, 0.3),
  },

  // 微信公众号
  wechat: {
    appId: process.env.WECHAT_APP_ID || '',
    appSecret: process.env.WECHAT_APP_SECRET || '',
    apiBase: 'https://api.weixin.qq.com',
  },

  // 飞书
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    chatId: process.env.FEISHU_CHAT_ID || '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    apiBase: 'https://open.feishu.cn/open-apis',
  },

  // 图片服务：按文章内容去图库搜图，插入正文并作为封面
  // provider 设为 none 可整体关闭（关闭后行为与旧版一致：正文无图、封面取素材库第一张）
  image: {
    provider: process.env.IMAGE_PROVIDER || 'unsplash',
    unsplashKey: process.env.UNSPLASH_ACCESS_KEY || '',
    pexelsKey: process.env.PEXELS_API_KEY || '',
    // 每篇文章插入正文的配图数量
    count: int(process.env.IMAGE_COUNT, 2),
    // 是否把第一张配图同时用作封面。
    // 注意：微信要求封面必须是永久素材的 media_id，开启后会往你的公众号素材库上传图片。
    asCover: bool(process.env.IMAGE_AS_COVER, true),
    requestTimeoutMs: int(process.env.IMAGE_REQUEST_TIMEOUT_MS, 15_000),
    unsplashApiBase: 'https://api.unsplash.com',
    pexelsApiBase: 'https://api.pexels.com',
  },

  // 爬虫
  crawler: {
    // 下面这些接口地址都是固定的常量（不是环境变量）。
    // 集中放在这里是为了：① 一眼看清三级兜底分别打哪个接口；② 测试时能改指向本地 mock 服务。
    weiboUrl: 'https://weibo.com/ajax/side/hotSearch',
    douyinUrl: 'https://www.douyin.com/aweme/v1/web/hot/search/list/',
    douyinMobileUrl: 'https://www.douyin.com/web/api/v2/hotsearch/billboard/word/',
    weiboBackupUrl: 'https://s.weibo.com/top/summary',
    weiboFallbackUrl: 'https://tenapi.cn/v2/weibohot', // 第三方接口备用
    douyinFallbackUrl: 'https://tenapi.cn/v2/douyinhot',
    weiboCookie: process.env.WEIBO_COOKIE || '',
    douyinCookie: process.env.DOUYIN_COOKIE || '',
    requestTimeoutMs: int(process.env.CRAWLER_TIMEOUT_MS, 15_000),
  },

  // 运行
  run: {
    cronSchedule: process.env.CRON_SCHEDULE || '0 */2 * * *',
    topicsPerRun: int(process.env.TOPICS_PER_RUN, 3),
    // 两条话题之间的间隔，避免触发平台频控
    topicIntervalMs: num(process.env.TOPIC_INTERVAL_SECONDS, 5) * 1000,
    localServerPort: int(process.env.LOCAL_SERVER_PORT, 8080),
    // 注意：日志级别在 log.level，不在这个段里。曾经这里放过一个 run.logLevel，
    // 但没有任何代码读它，改它不会有任何效果（同一个 LOG_LEVEL 环境变量已经由 log.level 消费）。
    // HTTP 请求体大小上限（字节），防止内存被撑爆
    maxBodyBytes: int(process.env.MAX_BODY_BYTES, 1_000_000),
  },

  // Agent 配置
  agent: {
    maxIterations: int(process.env.AGENT_MAX_ITERATIONS, 10), // Agent 最大循环次数
    memorySize: int(process.env.AGENT_MEMORY_SIZE, 20), // 每个会话保留的消息条数
    webPort: int(process.env.AGENT_WEB_PORT, 3000), // Web 聊天服务端口
    webCorsOrigin: process.env.WEB_CORS_ORIGIN || '*', // Web 允许的跨域来源
    webAccessToken: process.env.WEB_ACCESS_TOKEN || '', // 留空则不校验
    // Web 登录页账号密码。两者**同时**配置才启用登录；都为空则直接进助手页（与加登录前一致）
    webLoginUser: process.env.WEB_LOGIN_USER || '',
    webLoginPassword: process.env.WEB_LOGIN_PASSWORD || '',
    // 会话 cookie 的签名密钥。留空则由账号密码派生 —— 省掉一个要保管的密钥，
    // 且改密码会自动让旧会话失效；对外暴露服务时建议显式配置。
    webSessionSecret: process.env.WEB_SESSION_SECRET || '',
    // 登录有效期（小时）。下限 5 分钟，避免误配成 0 导致刚登录就掉线
    webSessionTtlMs: Math.max(5 * 60_000, num(process.env.WEB_SESSION_TTL_HOURS, 12) * 3600_000),
    // 单条工具结果写入对话记忆时的截断长度，避免上下文膨胀
    maxToolResultChars: int(process.env.AGENT_MAX_TOOL_RESULT_CHARS, 8_000),
  },

  // 日志
  log: {
    level: process.env.LOG_LEVEL || 'info',
    // 下限 1KB，避免误配成 0 导致每写一行就轮转一次
    maxSizeBytes: Math.max(1024, int(process.env.LOG_MAX_SIZE_MB, 10) * 1024 * 1024),
    maxFiles: Math.max(1, int(process.env.LOG_MAX_FILES, 7)),
    dir: fromRoot(process.env.LOG_DIR || 'logs'),
  },

  // 文章生成风格配置
  articleStyle: {
    // 可选风格: 'default' | 'jaychou'
    style: process.env.ARTICLE_STYLE || 'default',
    // 采样温度。反 AI 检测靠的是句式多样性，温度太低会让表达更"标准"、更像 AI
    temperature: num(process.env.ARTICLE_TEMPERATURE, 0.9),
    // 单次生成的最大输出 token。文章越长（含内联样式 HTML）越容易截断
    maxTokens: int(process.env.ARTICLE_MAX_TOKENS, 4096),
    // 生成后是否做"去 AI 味"后处理（套话替换 + 长段落打散）
    humanize: bool(process.env.ARTICLE_HUMANIZE, true),
    // 人味自检分低于该值时带反馈重写；设为 0 则从不重写
    minHumanScore: int(process.env.ARTICLE_MIN_HUMAN_SCORE, 70),
    // 最多重写几轮。每轮都要重新调一次模型，是唯一的额外成本
    rewriteRounds: int(process.env.ARTICLE_REWRITE_ROUNDS, 1),
    // 单篇文章的**总**时间预算（毫秒），覆盖"重试 + 重写轮次"全部环节。
    // 存在的理由：AI_REQUEST_TIMEOUT_MS 只是**单次请求**超时，它 ×(重试次数+1)×(重写轮次+1)
    // 才是单篇的最坏耗时——默认 600s 时这个乘积是 80 分钟，而调度周期只有 12 小时、
    // 流水线还是串行的，一篇文章卡住会把后面全部挤掉。
    // 有了总预算，无论超时/重试/重写怎么叠加，单篇都不会超过这个数。
    totalBudgetMs: int(process.env.ARTICLE_TOTAL_BUDGET_MS, 600_000),
  },

  // 通用请求头
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },

  // 缓存文件（绝对路径，与启动目录无关）
  cacheFile: fromRoot(process.env.CACHE_FILE || '.cache/processed_topics.json'),
  tokenCacheFile: fromRoot(process.env.WECHAT_TOKEN_CACHE_FILE || '.cache/wechat_token.json'),
};

const VALID_PROVIDERS = ['claude', 'openai', 'doubao'];
const PROVIDER_KEY_FIELD = {
  claude: ['anthropicKey', 'ANTHROPIC_API_KEY'],
  openai: ['openaiKey', 'OPENAI_API_KEY'],
  doubao: ['doubaoKey', 'DOUBAO_API_KEY'],
};
const VALID_STYLES = ['default', 'jaychou'];
const VALID_IMAGE_PROVIDERS = ['unsplash', 'pexels', 'none'];

/**
 * 占位值检测。
 * `.env.example` 里的示例值（your_xxx / xxx / placeholder ...）经常被原样留在 `.env` 里，
 * 只判断"非空"会误以为已配置，然后在运行时拿到一个 401，排查起来很绕。
 */
const PLACEHOLDER_PATTERN = /^(your[_-]|xxx|placeholder|changeme|todo|sk-xxx)/i;
export const isPlaceholder = (value) => PLACEHOLDER_PATTERN.test(String(value ?? '').trim());

/** 真正可用的 key（非空且不是占位值） */
const usableKey = (value) => Boolean(value) && !isPlaceholder(value);

/**
 * 配图能力是否可用：provider 有效、对应 key 真实配置、且数量 > 0。
 * 调用方据此决定要不要走搜图流程——不可用时静默跳过，不影响发布。
 */
export function isImageEnabled() {
  const { provider, unsplashKey, pexelsKey, count } = config.image;
  if (provider === 'none' || count <= 0) return false;
  if (provider === 'unsplash') return usableKey(unsplashKey);
  if (provider === 'pexels') return usableKey(pexelsKey);
  return false;
}

/**
 * 启动期配置校验：尽早暴露"跑起来才发现"的配置错误
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateConfig() {
  const errors = [];
  const warnings = [];

  if (!VALID_PROVIDERS.includes(config.ai.provider)) {
    errors.push(`AI_PROVIDER 无效: "${config.ai.provider}"，可选 ${VALID_PROVIDERS.join(' / ')}`);
  } else {
    const [field, envName] = PROVIDER_KEY_FIELD[config.ai.provider];
    if (!config.ai[field]) errors.push(`AI_PROVIDER=${config.ai.provider} 但未配置 ${envName}`);
  }

  if (!VALID_STYLES.includes(config.articleStyle.style)) {
    warnings.push(`ARTICLE_STYLE 无效: "${config.articleStyle.style}"，回退为 default`);
    config.articleStyle.style = 'default';
  }

  // 采样参数越界会被模型接口直接拒掉，这里提前夹到合法区间
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  if (config.articleStyle.temperature < 0 || config.articleStyle.temperature > 2) {
    warnings.push(`ARTICLE_TEMPERATURE 应在 0-2 之间，已夹到区间内`);
    config.articleStyle.temperature = clamp(config.articleStyle.temperature, 0, 2);
  }
  if (config.ai.frequencyPenalty < -2 || config.ai.frequencyPenalty > 2) {
    warnings.push('AI_FREQUENCY_PENALTY 应在 -2 到 2 之间，已夹到区间内');
    config.ai.frequencyPenalty = clamp(config.ai.frequencyPenalty, -2, 2);
  }
  if (config.ai.presencePenalty < -2 || config.ai.presencePenalty > 2) {
    warnings.push('AI_PRESENCE_PENALTY 应在 -2 到 2 之间，已夹到区间内');
    config.ai.presencePenalty = clamp(config.ai.presencePenalty, -2, 2);
  }
  if (config.articleStyle.minHumanScore < 0 || config.articleStyle.minHumanScore > 100) {
    warnings.push('ARTICLE_MIN_HUMAN_SCORE 应在 0-100 之间，已夹到区间内');
    config.articleStyle.minHumanScore = clamp(config.articleStyle.minHumanScore, 0, 100);
  }
  if (config.articleStyle.rewriteRounds < 0) {
    warnings.push('ARTICLE_REWRITE_ROUNDS 不能为负，已回退为 0');
    config.articleStyle.rewriteRounds = 0;
  }
  if (config.articleStyle.maxTokens < 1024) {
    warnings.push('ARTICLE_MAX_TOKENS 过小（< 1024），可能写不完一篇带排版的文章，已提升为 1024');
    config.articleStyle.maxTokens = 1024;
  }

  if (config.run.topicsPerRun < 1) {
    warnings.push(`TOPICS_PER_RUN 应 >= 1，已回退为 1`);
    config.run.topicsPerRun = 1;
  }

  if (config.agent.maxIterations < 1) {
    warnings.push('AGENT_MAX_ITERATIONS 应 >= 1，已回退为 10');
    config.agent.maxIterations = 10;
  }

  // 记忆窗口太小会把 tool_call / tool_result 配对切碎，导致模型接口报错
  if (config.agent.memorySize < 8) {
    warnings.push('AGENT_MEMORY_SIZE 过小（< 8），可能导致工具调用上下文被截断，已提升为 8');
    config.agent.memorySize = 8;
  }

  if (!config.wechat.appId) warnings.push('微信公众号未配置，将跳过草稿发布');
  if (!config.feishu.appId) warnings.push('飞书未配置，将跳过飞书通知与机器人');
  if (!config.crawler.weiboCookie) warnings.push('WEIBO_COOKIE 未配置，微博爬取成功率可能偏低');

  // 登录页只配一半等于没配（isLoginEnabled 要求两者同时存在），这种"设置了但没生效"
  // 不报错不警告，只能靠这里点出来
  if (Boolean(config.agent.webLoginUser) !== Boolean(config.agent.webLoginPassword)) {
    warnings.push('WEB_LOGIN_USER / WEB_LOGIN_PASSWORD 只配了一个，登录页不会启用（需同时配置）');
  }

  // 配图：配置不完整只降级，不算错误——不能因为图库没配好就发不出文章
  if (!VALID_IMAGE_PROVIDERS.includes(config.image.provider)) {
    warnings.push(
      `IMAGE_PROVIDER 无效: "${config.image.provider}"，可选 ${VALID_IMAGE_PROVIDERS.join(' / ')}，已关闭配图`
    );
    config.image.provider = 'none';
  } else if (config.image.provider !== 'none') {
    const key = config.image.provider === 'unsplash' ? config.image.unsplashKey : config.image.pexelsKey;
    const envName = config.image.provider === 'unsplash' ? 'UNSPLASH_ACCESS_KEY' : 'PEXELS_API_KEY';
    if (!key) warnings.push(`IMAGE_PROVIDER=${config.image.provider} 但未配置 ${envName}，将跳过配图`);
    else if (isPlaceholder(key))
      warnings.push(`${envName} 还是占位值（"${key}"），请换成真实 Key，否则将跳过配图`);
  }
  if (config.image.count < 0) {
    warnings.push('IMAGE_COUNT 不能为负，已回退为 0');
    config.image.count = 0;
  }
  if (!config.wechat.appId && config.image.asCover) {
    // 封面要上传永久素材，得先有公众号凭证
    warnings.push('未配置微信公众号，IMAGE_AS_COVER 不会生效');
  }

  return { errors, warnings };
}

export default config;
