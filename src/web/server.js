/**
 * Web 聊天服务
 * 提供简单的 Web 聊天界面和 API 接口
 * - GET  /            → 助手页（未登录则跳转 /login）
 * - GET  /login       → 登录页（已登录则跳回 /）
 * - POST /api/login   → 账号密码登录，成功下发签名会话 cookie
 * - POST /api/logout  → 退出登录
 * - GET  /api/me      → 当前登录账号
 * - POST /api/chat    → 与 Agent 对话
 * - GET  /api/status  → 系统状态（直接读工具，不再白烧一次 LLM 调用）
 * - POST /api/reset   → 清空会话
 * - GET  /health      → 健康检查
 *
 * 登录是否启用取决于 .env 里是否配了 WEB_LOGIN_USER / WEB_LOGIN_PASSWORD：
 * 都为空时整个登录环节静默跳过，行为与加登录之前完全一致。
 */
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { readBody } from '../utils/helpers.js';
import { executeTool } from '../agent/tools.js';
import {
  isLoginEnabled,
  verifyCredentials,
  createSessionToken,
  getSession,
  buildSessionCookie,
  buildClearCookie,
  checkLoginThrottle,
  recordLoginFailure,
  recordLoginSuccess,
} from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('../agent/core.js').default} */
let _agent = null;

/**
 * 启动 Web 服务
 * @param {import('../agent/core.js').default} agent
 * @returns {import('http').Server}
 */
export function start(agent) {
  _agent = agent;
  const port = config.agent?.webPort || 3000;

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error(`Web 请求处理异常: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(`✅ Web聊天服务已启动: http://localhost:${port}`);
    if (isLoginEnabled()) logger.info(`   已启用登录页，账号: ${config.agent.webLoginUser}`);
    if (config.agent.webAccessToken) logger.info('   已启用访问令牌校验 (x-web-token)');
  });
  return server;
}

async function handleRequest(req, res) {
  const method = req.method;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', config.agent.webCorsOrigin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-web-token');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (method === 'GET' && pathname === '/health') {
    return json(res, 200, { status: 'ok', agentReady: Boolean(_agent) });
  }

  const loginEnabled = isLoginEnabled();
  const session = loginEnabled ? getSession(req) : null;
  const authed = !loginEnabled || Boolean(session);

  // 登录页：已登录的人不该再看到它，直接送回助手页
  if (method === 'GET' && (pathname === '/login' || pathname === '/login.html')) {
    if (authed) return redirect(res, '/');
    return serveFile(res, join(__dirname, 'public', 'login.html'), 'text/html');
  }

  if (method === 'POST' && pathname === '/api/login') {
    return handleLogin(req, res, loginEnabled);
  }

  if (method === 'POST' && pathname === '/api/logout') {
    res.setHeader('Set-Cookie', buildClearCookie());
    logger.info(`Web 退出登录: ${session?.username || '未登录'}`);
    return json(res, 200, { success: true });
  }

  // 未登录：页面走 302 跳登录页，接口返回 401（前端凭 loginRequired 自己跳）
  if (!authed) {
    if (method === 'GET' && !pathname.startsWith('/api/')) return redirect(res, '/login');
    return json(res, 401, { error: 'unauthorized', loginRequired: true });
  }

  if (method === 'GET' && pathname === '/api/me') {
    return json(res, 200, { username: session?.username || '', loginEnabled });
  }

  // 静态页面
  if (method === 'GET' && pathname === '/') {
    return serveFile(res, join(__dirname, 'public', 'index.html'), 'text/html');
  }

  // 其余接口在配置了 WEB_ACCESS_TOKEN 时需要带令牌
  if (config.agent.webAccessToken && req.headers['x-web-token'] !== config.agent.webAccessToken) {
    return json(res, 401, { error: 'unauthorized' });
  }

  // API: 对话
  if (method === 'POST' && pathname === '/api/chat') {
    let body;
    try {
      body = await readBody(req, config.run.maxBodyBytes);
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message });
    }

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }

    try {
      const { message, sessionId } = payload;
      if (!message || typeof message !== 'string') {
        return json(res, 400, { error: 'message is required' });
      }
      if (!_agent) {
        return json(res, 503, { error: 'Agent not initialized' });
      }

      const response = await _agent.run(message, {
        sessionId: sessionId || 'web_default',
        platform: 'web',
      });

      return json(res, 200, {
        reply: response.reply,
        thinkingSteps: response.thinkingSteps,
        iterations: response.iterations,
      });
    } catch (err) {
      logger.error(`Web chat error: ${err.message}`);
      return json(res, 500, { error: err.message });
    }
  }

  // API: 系统状态（直接调用工具，省掉一次 LLM 往返）
  if (method === 'GET' && pathname === '/api/status') {
    try {
      const status = await executeTool('get_system_status', {});
      return json(res, 200, { status });
    } catch (err) {
      return json(res, 500, { error: err.message });
    }
  }

  // API: 清空会话
  if (method === 'POST' && pathname === '/api/reset') {
    let body;
    try {
      body = await readBody(req, config.run.maxBodyBytes);
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message });
    }

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }

    const { sessionId } = payload;
    if (_agent) _agent.memory.clear(sessionId || 'web_default');
    return json(res, 200, { success: true });
  }

  json(res, 404, { error: 'not found' });
}

/**
 * 处理登录请求
 * 失败一律回同一句"账号或密码不正确"，不区分是账号错还是密码错，避免被拿来枚举账号。
 */
async function handleLogin(req, res, loginEnabled) {
  if (!loginEnabled) {
    return json(res, 503, { error: '登录未启用：请在 .env 里配置 WEB_LOGIN_USER / WEB_LOGIN_PASSWORD' });
  }

  const source = clientKey(req);
  const before = checkLoginThrottle(source);
  if (before.blocked) {
    res.setHeader('Retry-After', String(before.retryAfterSec));
    return json(res, 429, { error: `尝试次数过多，请 ${Math.ceil(before.retryAfterSec / 60)} 分钟后再试` });
  }

  let body;
  try {
    body = await readBody(req, config.run.maxBodyBytes);
  } catch (err) {
    return json(res, err.statusCode || 400, { error: err.message });
  }

  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return json(res, 400, { error: 'invalid json' });
  }

  const { username, password, remember } = payload || {};

  if (!verifyCredentials(username, password)) {
    const after = recordLoginFailure(source);
    logger.warn(`Web 登录失败: 账号 "${sanitizeForLog(username)}" 来源 ${source}`);
    if (after.blocked) {
      res.setHeader('Retry-After', String(after.retryAfterSec));
      return json(res, 429, { error: '尝试次数过多，请稍后再试' });
    }
    return json(res, 401, { error: '账号或密码不正确', remaining: after.remaining });
  }

  recordLoginSuccess(source);
  // remember 未显式传时按"记住我"处理，保持对老前端的兼容
  res.setHeader('Set-Cookie', buildSessionCookie(createSessionToken(username), remember !== false));
  logger.info(`Web 登录成功: ${username}`);
  return json(res, 200, { success: true, username });
}

/** 限流按来源 IP 计数 */
function clientKey(req) {
  return req.socket?.remoteAddress || 'unknown';
}

/** 用户名会写进日志，去掉换行避免伪造日志行 */
function sanitizeForLog(value) {
  return String(value ?? '').replace(/[\r\n\t]/g, ' ').slice(0, 40);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function serveFile(res, filePath, contentType) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
