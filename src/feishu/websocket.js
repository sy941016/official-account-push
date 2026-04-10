/**
 * 飞书机器人 - WebSocket 长连接模式（推荐）
 * Agent 模式：所有消息交给 Agent 处理，Agent 自主决策调用工具
 *
 * 前置步骤：
 * 1. 飞书开放平台 → 应用功能 → 机器人 → 开启机器人
 * 2. 事件订阅 → 使用长连接 → 添加事件 im.message.receive_v1
 * 3. node src/main.js --mode=websocket
 */
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { createDedupeCache } from '../utils/helpers.js';
import { sendText, sendErrorAlert } from './app.js';

/** @type {import('../agent/core.js').default} */
let _agent = null;

/** 长连接偶发重推同一事件，按 message_id 去重 */
const _seenMessages = createDedupeCache();

/**
 * 初始化 WebSocket 模块，注入 Agent 实例
 * @param {import('../agent/core.js').default} agent
 */
export function init(agent) {
  _agent = agent;
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
  } catch {
    logger.error('请安装飞书SDK: npm install @larksuiteoapi/node-sdk');
    return;
  }

  // 消息事件处理器
  const eventHandler = async (data) => {
    try {
      const msg = data.message;
      if (msg.message_id && _seenMessages.seen(msg.message_id)) return;
      if (msg.message_type !== 'text') return;

      const content = JSON.parse(msg.content);
      let text = content.text?.trim() || '';
      const chatId = msg.chat_id || '';

      // 移除 @机器人 的格式
      text = text.replace(/<at id="[^>]+"><\/at>/g, '')
                 .replace(/@[^\s]+\s?/g, '')
                 .trim();

      if (!text) return;

      logger.info(`收到飞书消息: "${text}" (chat: ${chatId})`);

      // 交给 Agent 处理
      handleAgentMessage(text, chatId).catch(err =>
        logger.error(`Agent处理异常: ${err.message}`)
      );
    } catch (err) {
      logger.error(`消息解析异常: ${err.message}`);
    }
  };

  // 卡片按钮点击处理器（Agent 模式：按钮发送自然语言指令）
  const cardActionHandler = async (data) => {
    try {
      const action = data?.action?.value?.action || '';
      const chatId = data?.context?.open_chat_id || '';
      logger.info(`收到卡片交互: action=${action}, chat=${chatId}`);

      // 将卡片按钮动作转化为自然语言，交给 Agent
      let naturalCommand = '';
      if (action === 'fetch_hot') {
        naturalCommand = '用默认风格帮我抓取最新热点，选最热的话题生成一篇文章并推送到公众号';
      } else if (action === 'fetch_jaychou') {
        naturalCommand = '用周杰伦风格帮我生成一篇情感文章并推送到公众号';
      } else if (action === 'show_status') {
        naturalCommand = '查看系统运行状态';
      }

      if (naturalCommand && chatId) {
        handleAgentMessage(naturalCommand, chatId).catch(err =>
          logger.error(`卡片Agent处理异常: ${err.message}`)
        );
      }

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

    const wsClient = new lark.WSClient({
      appId,
      appSecret,
      loggerLevel: lark.LoggerLevel?.info || 'info',
    });

    wsClient.start({ eventDispatcher });
    logger.info('✅ 飞书WebSocket已连接（Agent模式），等待消息...');
  } else {
    logger.error('飞书SDK版本过低或不支持WebSocket模式');
    return;
  }

  logger.info('   自然语言交互：直接跟 Agent 对话即可');
}

/**
 * 处理 Agent 消息
 * @param {string} text 用户消息
 * @param {string} chatId 飞书群聊ID
 */
async function handleAgentMessage(text, chatId) {
  if (!_agent) {
    await sendText('⚠️ Agent 未初始化，请检查系统配置', chatId);
    return;
  }

  // 先告知用户正在处理
  await sendText('🤔 正在思考中...', chatId);

  try {
    const response = await _agent.run(text, {
      sessionId: chatId,
      platform: 'feishu',
      onThinking: (step) => {
        // 实时推送工具调用进度
        if (step.type === 'tool_call') {
          const toolNames = {
            crawl_weibo: '📡 爬取微博热搜',
            crawl_douyin: '📡 爬取抖音热点',
            generate_article: '📝 生成文章',
            publish_to_wechat: '📤 推送到公众号',
            send_feishu_notification: '💬 发送飞书消息',
            get_system_status: '📊 查询系统状态',
            search_cached_topics: '🔍 搜索缓存热点',
          };
          const desc = toolNames[step.name] || step.name;
          sendText(`⚙️ 正在执行: ${desc}`, chatId).catch(() => {});
        }
      },
    });

    // 发送 Agent 最终回复
    if (response.reply) {
      // 飞书消息长度限制，截断过长内容
      const maxLen = 4000;
      const reply = response.reply.length > maxLen
        ? response.reply.slice(0, maxLen) + '\n\n...(内容过长已截断)'
        : response.reply;
      await sendText(reply, chatId);
    }
  } catch (err) {
    logger.error(`Agent执行失败: ${err.message}`);
    await sendErrorAlert(err.message, 'Agent消息处理', chatId);
  }
}
