/**
 * 飞书机器人 - 本地 HTTP 事件回调服务
 * 需配合 ngrok / frp 等内网穿透工具
 *
 * 启动步骤：
 * 1. node src/feishu/server.js（或 npm run server）
 * 2. ngrok http 8080
 * 3. 将 https://xxxx.ngrok.io/feishu/event 填入飞书开放平台 → 事件订阅 → 请求地址
 */
import { createServer } from 'http';
import { createHash, createDecipheriv } from 'crypto';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { sendText, sendStatusCard, sendErrorAlert, parseCommand } from './app.js';

const { verificationToken, encryptKey } = config.feishu;
const PORT = config.run.localServerPort;

let _pipeline = null;
let _getStats = null;

export function init(pipelineFn, getStatsFn) {
  _pipeline = pipelineFn;
  _getStats = getStatsFn;
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
    const body = await readBody(req);
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

    // 事件回调——必须立即返回 200，异步处理
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
    if (msg.message_type !== 'text') return;

    const content = JSON.parse(msg.content || '{}');
    let text = (content.text || '').trim();
    const senderId = event?.sender?.sender_id?.user_id || '';
    const chatId = msg.chat_id || '';

    // 移除@机器人的各种格式
    // 1. 移除 <at id="xxx"></at>
    // 2. 移除 @_user_1 这种可能的占位符
    // 3. 移除首尾空格
    text = text.replace(/<at id="[^>]+><\/at>/g, '')
               .replace(/@[^\s]+\s?/g, '')
               .trim();

    logger.info(`收到飞书消息: "${text}" (chat: ${chatId}, from: ${senderId})`);

    const cmd = parseCommand(text);

    if (cmd === 'FETCH_HOT') {
      await sendText('🔄 正在抓取热点，生成文章中，请稍等...', chatId);
      if (_pipeline) {
        try { await _pipeline(); }
        catch (err) { await sendErrorAlert(err.message, '手动触发（HTTP Server）', chatId); }
      } else {
        await sendText('⚠️ 流程函数未初始化', chatId);
      }
    } else if (cmd === 'STATUS') {
      await sendStatusCard(_getStats ? _getStats() : {}, chatId);
    } else if (cmd === 'HELP') {
      await sendText(
        '🤖 热点内容机器人指令：\n\n' +
        '• /hot 或 抓取热点 — 立即爬取热点并生成文章\n' +
        '• /status 或 状态 — 查看系统运行状态\n' +
        '• /help — 显示帮助\n\n' +
        '系统按配置的 Cron 表达式自动运行。',
        chatId
      );
    } else {
      await sendText(`不太明白「${text}」，发送 /help 查看支持的指令。`, chatId);
    }
  } catch (err) {
    logger.error(`事件处理异常: ${err.message}`);
  }
}

// ===== 工具函数 =====
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
  });
}

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
    // 飞书加密算法：AES-256-CBC，key = sha256(encryptKey)
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
