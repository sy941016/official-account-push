/**
 * Web 聊天服务
 * 提供简单的 Web 聊天界面和 API 接口
 * - GET  /            → 聊天页面
 * - POST /api/chat    → 与 Agent 对话
 * - GET  /api/status  → 系统状态（直接读工具，不再白烧一次 LLM 调用）
 * - POST /api/reset   → 清空会话
 * - GET  /health      → 健康检查
 */
import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { readBody } from '../utils/helpers.js';
import { executeTool } from '../agent/tools.js';

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

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (method === 'GET' && pathname === '/health') {
    return json(res, 200, { status: 'ok', agentReady: Boolean(_agent) });
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

function serveFile(res, filePath, contentType) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
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
  });
  res.end(payload);
}
