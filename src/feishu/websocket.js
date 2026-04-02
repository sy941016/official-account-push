/**
 * 飞书机器人 - WebSocket 长连接模式（推荐）
 * ✅ 无需公网 IP，无需内网穿透，本地直接运行
 *
 * 前置步骤：
 * 1. 飞书开放平台 → 应用功能 → 机器人 → 开启机器人
 * 2. 事件订阅 → 使用长连接 → 添加事件 im.message.receive_v1
 * 3. node src/feishu/websocket.js
 */
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { sendText, sendStatusCard, sendErrorAlert, parseCommand } from './app.js';

let _pipeline = null;
let _getStats = null;

export function init(pipelineFn, getStatsFn) {
  _pipeline = pipelineFn;
  _getStats = getStatsFn;
}

export async function startWebSocket() {
  const { appId, appSecret } = config.feishu;
  if (!appId || !appSecret) {
    logger.error('飞书 AppID/AppSecret 未配置');
    return;
  }

  let lark;
  try {
    lark = await import('@larksuiteoapi/node-sdk');
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const sdkPkg = require('@larksuiteoapi/node-sdk/package.json');
    logger.info(`飞书SDK导入成功，版本: ${sdkPkg.version}`);
    logger.info('飞书SDK可用属性:', Object.keys(lark));
  } catch {
    logger.error('请安装飞书SDK: npm install @larksuiteoapi/node-sdk');
    return;
  }

  // 创建事件处理器
  const eventHandler = async (data) => {
    try {
      const msg = data.message;
      if (msg.message_type !== 'text') return;

      const content = JSON.parse(msg.content);
      let text = content.text?.trim() || '';
      const senderId = data.sender?.sender_id?.user_id || '';
      const chatId = msg.chat_id || '';
      
      // 移除@机器人的各种格式
      // 1. 移除 <at id="xxx"></at>
      // 2. 移除 @_user_1 这种可能的占位符
      // 3. 移除首尾空格
      text = text.replace(/<at id="[^>]+><\/at>/g, '')
                 .replace(/@[^\s]+\s?/g, '')
                 .trim();

      logger.info(`收到飞书消息: "${text}" (chat: ${chatId}, from: ${senderId})`);
      // 异步处理，不阻塞事件循环
      handleCommand(text, senderId, chatId).catch(err =>
        logger.error(`指令处理异常: ${err.message}`)
      );
    } catch (err) {
      logger.error(`消息解析异常: ${err.message}`);
    }
  };

  // 卡片按钮点击处理器
  const cardActionHandler = async (data) => {
    try {
      const action = data?.action?.value?.action || '';
      const chatId = data?.context?.open_chat_id || '';
      logger.info(`收到卡片交互: action=${action}, chat=${chatId}`);

      if (action === 'fetch_hot') {
        // 先异步触发抓取，不阻塞响应
        (async () => {
          await sendText('🔄 正在抓取热点，生成文章中，请稍等...', chatId);
          if (_pipeline) {
            try {
              await _pipeline();
            } catch (err) {
              logger.error(`流程异常: ${err.message}`);
              await sendErrorAlert(err.message, '卡片按钮触发', chatId);
            }
          } else {
            await sendText('⚠️ 流程函数未初始化，请检查 main.js', chatId);
          }
        })().catch(err => logger.error(`卡片触发异常: ${err.message}`));
      }

      // 返回飞书要求的正确响应格式
      return {};
    } catch (err) {
      logger.error(`卡片事件处理异常: ${err.message}`);
      return {};
    }
  };

  // 使用 EventDispatcher 和 WSClient
  if (lark.EventDispatcher && lark.WSClient) {
    const eventDispatcher = new lark.EventDispatcher({ appId, appSecret });
    eventDispatcher.register({
      'im.message.receive_v1': eventHandler,
      'card.action.trigger': cardActionHandler,
    });
    
    // ✅ 真正建立 WebSocket 连接
    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel?.info || 'info'
    });
    
    wsClient.start({ eventDispatcher });
    logger.info('✅ 飞书WebSocket已连接，等待消息...');
  } else {
    logger.error('飞书SDK版本过低或不支持WebSocket模式');
    return;
  }

  logger.info('   支持指令: /hot  /status  /help');
}

async function handleCommand(text, senderId, chatId) {
  const cmd = parseCommand(text);

  if (cmd === 'FETCH_HOT') {
    await sendText('🔄 正在抓取热点，生成文章中，请稍等...', chatId);
    if (_pipeline) {
      try {
        await _pipeline();
      } catch (err) {
        logger.error(`流程异常: ${err.message}`);
        await sendErrorAlert(err.message, '手动触发（WebSocket）', chatId);
      }
    } else {
      await sendText('⚠️ 流程函数未初始化，请检查 main.js', chatId);
    }
  } else if (cmd === 'STATUS') {
    const stats = _getStats ? _getStats() : {};
    await sendStatusCard(stats, chatId);
  } else if (cmd === 'HELP') {
    await sendText(
      '🤖 热点内容机器人指令：\n\n' +
      '• /hot 或 抓取热点 — 立即爬取热点并生成文章\n' +
      '• /status 或 状态 — 查看系统运行状态\n' +
      '• /help 或 帮助 — 显示此帮助信息\n\n' +
      '系统按配置的 Cron 表达式自动运行。',
      chatId
    );
  } else {
    await sendText(`不太明白「${text}」，发送 /help 查看支持的指令。`, chatId);
  }
}
