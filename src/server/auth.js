/**
 * Web 登录鉴权
 *
 * 账号密码来自环境变量 WEB_LOGIN_USER / WEB_LOGIN_PASSWORD，两者都配了才启用登录；
 * 都为空时 isLoginEnabled() 返回 false，页面直接进入助手页（与加登录前的行为一致）。
 *
 * 会话用「签名 cookie」实现，不引入任何依赖：
 *   oap_session = base64url(payload).base64url(HMAC-SHA256(payload))
 * payload 里只有用户名和过期时间，没有密码，也不放任何密钥。
 *
 * 注意：cookie 没带 Secure 属性 —— 本地是 http://localhost，带上浏览器会直接丢弃。
 * 若要把服务暴露到公网，请自行在反向代理上加 HTTPS，并给 cookie 补 Secure。
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import config from '../../config/index.js';

/** 会话 cookie 名 */
export const SESSION_COOKIE = 'oap_session';

/** 登录是否启用：账号和密码都配置了才算 */
export function isLoginEnabled() {
  return Boolean(config.agent.webLoginUser && config.agent.webLoginPassword);
}

/**
 * 会话签名密钥。
 * 优先用 WEB_SESSION_SECRET；没配则由账号密码派生 ——
 * 好处是不用额外保管一个密钥，且改密码会让所有旧会话自动失效；
 * 代价是同一套账号密码在任何机器上派生出同一个密钥，所以暴露到公网时应当显式配置。
 */
function sessionSecret() {
  if (config.agent.webSessionSecret) return config.agent.webSessionSecret;
  return createHash('sha256')
    .update(`oap-session|${config.agent.webLoginUser}|${config.agent.webLoginPassword}`)
    .digest('hex');
}

/**
 * 定长比较，用于所有涉及口令/签名的比对。
 * 先各自哈希成等长摘要再比：timingSafeEqual 遇到长度不等会直接抛异常，
 * 那样等于用异常把"长度对不对"泄露了出去。
 */
function safeEqual(a, b) {
  const digest = (v) => createHash('sha256').update(String(v)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const b64u = (buf) => Buffer.from(buf).toString('base64url');

function sign(payload) {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

/**
 * 校验账号密码
 * @param {unknown} username
 * @param {unknown} password
 * @returns {boolean}
 */
export function verifyCredentials(username, password) {
  if (!isLoginEnabled()) return false;
  if (typeof username !== 'string' || typeof password !== 'string') return false;
  // 两次比较都要执行，不能写 `userOk && passOk` —— 短路会让"账号对不对"从耗时上暴露出去
  const userOk = safeEqual(username, config.agent.webLoginUser);
  const passOk = safeEqual(password, config.agent.webLoginPassword);
  return userOk && passOk;
}

/**
 * 签发会话 token
 * @param {string} username
 * @param {number} [now] 便于测试注入时间
 */
export function createSessionToken(username, now = Date.now()) {
  const payload = b64u(
    JSON.stringify({ u: username, exp: now + config.agent.webSessionTtlMs })
  );
  return `${payload}.${sign(payload)}`;
}

/**
 * 校验会话 token
 * @param {unknown} token
 * @param {number} [now]
 * @returns {{username: string, exp: number}|null} 无效或过期返回 null
 */
export function verifySessionToken(token, now = Date.now()) {
  if (typeof token !== 'string' || !token) return null;

  const idx = token.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const signature = token.slice(idx + 1);

  if (!safeEqual(signature, sign(payload))) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!data || typeof data.u !== 'string' || typeof data.exp !== 'number') return null;
  if (data.exp <= now) return null;
  // 账号被改过，旧会话一律作废
  if (!safeEqual(data.u, config.agent.webLoginUser)) return null;

  return { username: data.u, exp: data.exp };
}

/**
 * 解析 Cookie 头。只做最小实现：同名取最后一个，值做一次 URL 解码。
 * @param {string|undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw; // 非法转义就按原样留着，不因为一个坏 cookie 让整个请求失败
    }
  }
  return out;
}

/**
 * 生成 Set-Cookie 值
 * @param {string} token
 * @param {boolean} [persistent=true] true = 带 Max-Age（关掉浏览器也还在，对应"记住我"）；
 *   false = 会话 cookie，浏览器一关就失效
 */
export function buildSessionCookie(token, persistent = true) {
  const base = `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`;
  if (!persistent) return base;
  return `${base}; Max-Age=${Math.floor(config.agent.webSessionTtlMs / 1000)}`;
}

/** 生成用于登出的 Set-Cookie 值 */
export function buildClearCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * 从请求里取当前登录用户
 * @param {import('http').IncomingMessage} req
 * @returns {{username: string, exp: number}|null}
 */
export function getSession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return verifySessionToken(token);
}

/* ============ 登录失败限流 ============ */
// 目的只有一个：拦住"对着登录接口穷举密码"。内存计数，重启即清零，
// 单进程小工具够用；将来要做集群再换成共享存储。

const MAX_ATTEMPTS = 5; // 窗口内允许的失败次数
const WINDOW_MS = 5 * 60_000; // 计数窗口
const BLOCK_MS = 5 * 60_000; // 触发后的封锁时长

/** @type {Map<string, {count: number, windowStart: number, blockedUntil: number}>} */
const attempts = new Map();

/**
 * 查询某个来源当前是否被限流
 * @param {string} key 通常用来源 IP
 * @param {number} [now]
 * @returns {{blocked: boolean, retryAfterSec: number, remaining: number}}
 */
export function checkLoginThrottle(key, now = Date.now()) {
  const entry = attempts.get(key);
  if (!entry) return { blocked: false, retryAfterSec: 0, remaining: MAX_ATTEMPTS };

  if (entry.blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000),
      remaining: 0,
    };
  }

  // 窗口过期就重新开始计数（封锁也已到期时顺手清掉）
  if (now - entry.windowStart > WINDOW_MS) {
    attempts.delete(key);
    return { blocked: false, retryAfterSec: 0, remaining: MAX_ATTEMPTS };
  }

  return { blocked: false, retryAfterSec: 0, remaining: Math.max(0, MAX_ATTEMPTS - entry.count) };
}

/**
 * 记一次登录失败，返回记录后的限流状态
 * @param {string} key
 * @param {number} [now]
 */
export function recordLoginFailure(key, now = Date.now()) {
  const entry = attempts.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now, blockedUntil: 0 });
    return checkLoginThrottle(key, now);
  }

  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.blockedUntil = now + BLOCK_MS;
  return checkLoginThrottle(key, now);
}

/** 登录成功清掉该来源的失败记录 */
export function recordLoginSuccess(key) {
  attempts.delete(key);
}

/** 清空全部限流记录（测试用） */
export function resetLoginThrottle() {
  attempts.clear();
}
