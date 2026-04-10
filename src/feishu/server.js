/**
 * 飞书机器人 - 本地 HTTP 事件回调服务
 * Agent 模式：消息交给 Agent 处理
 * 需配合 ngrok / frp 等内网穿透工具
 *
 * 启动步骤：
 * 1. node src/main.js --mode=server
 * 2. ngrok http 8080
 * 3. 将 https://xxxx.ngrok.io/feishu/event 填入飞书开放平台 → 事件订阅 → 请求地址
 */
import { createServer } from 'http';
import { createHash, createDecipheriv } from 'crypto';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { readBody, createDedupeCache } from '../utils/helpers.js';
import { sendText, sendErrorAlert } from './app.js';

const { verificationToken, encryptKey } = config.feishu;
const PORT = config.run.localServerPort;

/** 事件重复投递去重（5 分钟窗口） */
const _seenMessages = createDedupeCache();

/** @type {import('../agent/core.js').default} */
let _agent = null;

/**
 * 初始化 HTTP 回调服务
 * @param {import('../agent/core.js').default} agent
 */
export function init(agent) {
  _agent = agent;
}

export function startLocalServer() {
  const server = createServer(handleRequest);
  server.listen(PORT, '0.0.0.0', () => {
    logger.info(`✅ 飞书事件服务已启动: http://0.0.0.0:${PORT}`);
    logger.info(`   事件接收地址: POST http://你的域名:${PORT}/feishu/event`);
    logger.info(`   健康检查地址: GET  http://localhost:${PORT}/health`);
    logger.info('');
    logger.info('💡 内网穿透命令:');
    logger.info(`   ngrok: ngrok http ${PORT}`);
    logger.info(`   frp:   frpc http -l ${PORT} -s frps地址:7000 -u feishu-bot`);
  });
  return server;
}

// ===== 请求处理 =====
async function handleRequest(req, res) {
  const method = req.method;
  const url = req.url;

  // 健康检查
  if (method === 'GET' && url === '/health') {
    return json(res, 200, { status: 'ok', port: PORT });
  }

  // 飞书事件
  if (method === 'POST' && url === '/feishu/event') {
    let body;
    try {
      body = await readBody(req, config.run.maxBodyBytes);
    } catch (err) {
      return json(res, err.statusCode || 400, { error: err.message });
    }

    let data;
    try {
      data = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'invalid json' });
    }

    // 解密
    if (data.encrypt) {
      const decrypted = decrypt(data.encrypt);
      if (!decrypted) return json(res, 400, { error: 'decrypt failed' });
      data = decrypted;
    }

    // URL 验证（首次配置）
    if (data.type === 'url_verification') {
      if (verificationToken && data.token !== verificationToken) {
        logger.warn('飞书验证Token不匹配');
        return json(res, 403, { error: 'token mismatch' });
      }
      logger.info('✅ 飞书事件URL验证成功');
      return json(res, 200, { challenge: data.challenge });
    }

    // 事件回调——真实事件同样要校验 token，否则任何知道地址的人都能触发 Agent
    if (verificationToken) {
      const eventToken = data?.header?.token || data?.token || '';
      if (eventToken !== verificationToken) {
        logger.warn('飞书事件Token校验失败，已拒绝该请求');
        return json(res, 403, { error: 'token mismatch' });
      }
    } else {
      logger.warn('未配置 FEISHU_VERIFICATION_TOKEN，事件回调无鉴权保护，建议补充配置');
    }

    // 立即返回 200，异步处理
    json(res, 200, { code: 0 });

    const eventType = data?.header?.event_type || '';
    if (eventType === 'im.message.receive_v1') {
      handleMessageEvent(data.event).catch(err =>
        logger.error(`消息处理异常: ${err.message}`)
      );
    }
    return;
  }

  json(res, 404, { error: 'not found' });
}

async function handleMessageEvent(event) {
  try {
    const msg = event?.message || {};

    // 飞书未及时收到 200 时会重推同一事件，按 message_id 去重避免重复执行
    if (msg.message_id && _seenMessages.seen(msg.message_id)) {
      logger.info(`忽略重复投递的飞书消息: ${msg.message_id}`);
      return;
    }

    if (msg.message_type !== 'text') return;

    const content = JSON.parse(msg.content || '{}');
    let text = (content.text || '').trim();
    const chatId = msg.chat_id || '';

    // 移除@机器人的格式
    text = text.replace(/<at id="[^>]+"><\/at>/g, '')
               .replace(/@[^\s]+\s?/g, '')
               .trim();

    if (!text) return;

    logger.info(`收到飞书消息: "${text}" (chat: ${chatId})`);

    if (!_agent) {
      await sendText('⚠️ Agent 未初始化', chatId);
      return;
    }

    // 交给 Agent 处理
    const response = await _agent.run(text, {
      sessionId: chatId,
      platform: 'feishu',
    });

    if (response.reply) {
      const maxLen = 4000;
      const reply = response.reply.length > maxLen
        ? response.reply.slice(0, maxLen) + '\n\n...(内容过长已截断)'
        : response.reply;
      await sendText(reply, chatId);
    }
  } catch (err) {
    logger.error(`事件处理异常: ${err.message}`);
  }
}

// ===== 工具函数 =====
function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function decrypt(encryptStr) {
  if (!encryptKey) return null;
  try {
    const key = createHash('sha256').update(encryptKey).digest();
    const buf = Buffer.from(encryptStr, 'base64');
    const iv = buf.slice(0, 16);
    const cipherText = buf.slice(16);
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
    return JSON.parse(decrypted.toString('utf-8'));
  } catch (err) {
    logger.error(`飞书事件解密失败: ${err.message}`);
    return null;
  }
}
