/**
 * 通用工具函数
 */
import logger from './logger.js';

/**
 * 延迟指定毫秒
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 带指数退避的重试。只重试"看起来可恢复"的错误（网络抖动 / 429 / 5xx），
 * 参数错误之类的 4xx 直接抛出，避免无意义地等下去。
 *
 * @template T
 * @param {() => Promise<T>} fn 要执行的异步函数
 * @param {Object} [options]
 * @param {number} [options.retries=3]      最大重试次数（不含首次）
 * @param {number} [options.baseDelayMs=800] 退避基数，实际等待 = base * 2^n + 随机抖动
 * @param {number} [options.maxDelayMs=15000]
 * @param {string} [options.label='任务']    日志中显示的名称
 * @param {(err:any)=>boolean} [options.shouldRetry]
 * @param {number} [options.budgetMs=Infinity] 重试总预算（毫秒），超过后不再发起新的重试
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 800,
    maxDelayMs = 15_000,
    label = '任务',
    shouldRetry = isRetryableError,
    budgetMs = Infinity,
  } = options;

  const startedAt = Date.now();
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 预算用尽就不再发起新的重试。这一条是专门为**超时**加的：
    // timeout 在 isRetryableError 里算可重试（单次超时确实常常是抖动，重试能救回来），
    // 但一次超时可能就吃掉几百秒，重试 3 次能把一篇文章拖到 40 分钟以上。
    // 预算到顶就止损，把决定权交回调用方，而不是让重试一直占着调度窗口。
    if (attempt > 0 && Date.now() - startedAt >= budgetMs) {
      logger.warn(`${label} 重试预算 ${Math.round(budgetMs / 1000)}s 已用尽，不再重试`);
      throw lastErr;
    }
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err)) throw err;

      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt) + Math.floor(Math.random() * 300);
      logger.warn(
        `${label} 第 ${attempt + 1} 次失败，${Math.round(delay / 1000)}s 后重试: ${err.message}`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** 网络抖动、限流、服务端错误 → 值得重试 */
export function isRetryableError(err) {
  if (!err) return false;
  const status = err.status || err.statusCode || err.response?.status;
  if (status === 408 || status === 409 || status === 429) return true;
  if (status >= 500) return true;
  if (status >= 400) return false; // 4xx 多为请求本身有问题，重试无益

  const code = err.code || '';
  return [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
    'ENOTFOUND', 'ECONNABORTED', 'UND_ERR_CONNECT_TIMEOUT',
  ].includes(code);
}

/**
 * 读取 HTTP 请求体，并限制最大长度，防止超大请求打爆内存。
 *
 * 超限时不能立刻 destroy 掉请求——那样客户端拿不到 413 响应，只会看到一个空回复。
 * 正确做法是把剩余数据丢弃（不再累积），等请求结束后再抛出，由调用方回 413。
 *
 * @param {import('http').IncomingMessage} req
 * @param {number} [maxBytes]
 * @returns {Promise<string>}
 */
export function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        if (!overflowed) {
          overflowed = true;
          chunks.length = 0; // 释放已缓冲的内容
        }
        return; // 丢弃后续数据，不再占用内存
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflowed) {
        reject(Object.assign(new Error(`请求体超过上限 ${maxBytes} 字节`), { statusCode: 413 }));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });

    req.on('error', reject);
  });
}

/**
 * 按 key 去重，保留首次出现的元素
 * @template T
 * @param {T[]} list
 * @param {(item:T)=>string} keyFn
 * @returns {T[]}
 */
export function dedupeBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 截断字符串，超出部分用省略标记替代
 * @param {string} str
 * @param {number} max
 * @param {string} [suffix='...(已截断)']
 */
export function truncate(str, max, suffix = '...(已截断)') {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max) + suffix : s;
}

/** 以本地时区返回 YYYY-MM-DD，用于"今日"这类按自然日统计的逻辑 */
export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 生成一张居中配图的 HTML（公众号正文里的图片都包在 <p> 里） */
function imageTag(url) {
  const safe = String(url).replace(/"/g, '&quot;');
  return `<p style="margin: 24px 0; text-align: center;"><img src="${safe}" style="max-width: 100%;" /></p>`;
}

/**
 * 把配图均匀插入文章正文
 *
 * 纯字符串处理，不依赖 DOM：以段落结束标签 `</p>` 为锚点，把图片均匀分布到正文中。
 * 两条刻意的约束：
 *   1. 不插在最后一段之后 —— 文章收尾放图很突兀；
 *   2. 锚点只会落在 `</p>` 之后，因此不会出现"小标题和它下面第一段之间被塞了图"。
 *
 * @param {string} html 正文 HTML
 * @param {string[]} imageUrls 图片地址，顺序即插入顺序
 * @returns {string} 插入后的 HTML；无图或无正文时原样返回
 */
export function insertImages(html, imageUrls) {
  const source = String(html ?? '');
  const urls = (imageUrls || []).filter(Boolean);
  if (urls.length === 0 || !source) return source;

  const anchors = [...source.matchAll(/<\/p\s*>/gi)].map((m) => m.index + m[0].length);

  // 一段都没有（比如正文是纯 h2/div）：退化成都追加到末尾
  if (anchors.length === 0) return source + urls.map(imageTag).join('');

  const usable = anchors.length > 1 ? anchors.slice(0, -1) : anchors;
  const n = Math.min(urls.length, usable.length);

  // 把 usable 分成 n+1 段，每张图落在所在段的末尾锚点，从而均匀铺开
  const byPosition = new Map();
  for (let i = 0; i < n; i++) {
    const pos = usable[Math.min(usable.length - 1, Math.floor((usable.length * (i + 1)) / (n + 1)))];
    if (!byPosition.has(pos)) byPosition.set(pos, []);
    byPosition.get(pos).push(urls[i]);
  }

  let out = '';
  let cursor = 0;
  for (const pos of [...byPosition.keys()].sort((a, b) => a - b)) {
    out += source.slice(cursor, pos) + byPosition.get(pos).map(imageTag).join('');
    cursor = pos;
  }
  return out + source.slice(cursor);
}

/**
 * 创建一个带 TTL 的去重集合，用于屏蔽重复投递的消息
 * （飞书在超时未收到 200 时会重推同一事件，不屏蔽就会重复触发 Agent）
 *
 * @param {number} [ttlMs=5*60*1000]
 * @param {number} [maxSize=1000]
 * @returns {{seen:(key:string)=>boolean, size:number}}
 */
export function createDedupeCache(ttlMs = 5 * 60 * 1000, maxSize = 1000) {
  const map = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [key, ts] of map) {
      if (now - ts > ttlMs) map.delete(key);
    }
    while (map.size > maxSize) {
      map.delete(map.keys().next().value);
    }
  };

  return {
    /** 首次出现返回 false，重复出现返回 true */
    seen(key) {
      if (!key) return false;
      const now = Date.now();
      const hit = map.has(key) && now - map.get(key) <= ttlMs;
      map.set(key, now);
      if (map.size > maxSize || Math.random() < 0.01) prune();
      return hit;
    },
    get size() {
      return map.size;
    },
  };
}
