/**
 * 飞书自建应用核心模块
 * - tenant_access_token 管理
 * - 发送消息卡片（文章通知、状态、告警）
 * - Agent 模式下不再需要指令解析，由 Agent 直接处理自然语言
 */
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../utils/logger.js';

const { apiBase, appId, appSecret, chatId } = config.feishu;

// ===== Token =====
let _tokenCache = null;

export async function getTenantToken() {
  if (_tokenCache && Date.now() < _tokenCache.expireAt - 60_000) {
    return _tokenCache.token;
  }
  if (!appId || !appSecret) {
    logger.error('飞书 AppID / AppSecret 未配置');
    return null;
  }
  try {
    const { data } = await axios.post(
      `${apiBase}/auth/v3/tenant_access_token/internal`,
      { app_id: appId, app_secret: appSecret },
      { timeout: 10_000 }
    );
    if (data.code !== 0) { logger.error(`飞书Token失败: ${JSON.stringify(data)}`); return null; }
    _tokenCache = { token: data.tenant_access_token, expireAt: Date.now() + (data.expire || 7200) * 1000 };
    return _tokenCache.token;
  } catch (err) {
    logger.error(`飞书Token异常: ${err.message}`);
    return null;
  }
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' };
}

// ===== 发送消息 =====
async function sendMessage(receiveChatId, msgType, content) {
  const token = await getTenantToken();
  if (!token) return false;
  try {
    const { data } = await axios.post(
      `${apiBase}/im/v1/messages`,
      { receive_id: receiveChatId, msg_type: msgType, content: JSON.stringify(content) },
      { params: { receive_id_type: 'chat_id' }, headers: authHeaders(token), timeout: 15_000 }
    );
    if (data.code === 0) { logger.info(`飞书消息发送成功 (${msgType})`); return true; }
    logger.error(`飞书消息发送失败: ${JSON.stringify(data)}`);
    return false;
  } catch (err) {
    logger.error(`飞书消息异常: ${err.message}`);
    return false;
  }
}

export const sendText = (text, cid = chatId) =>
  sendMessage(cid, 'text', { text });

// ===== 文章发布通知卡片 =====
export async function sendArticleCard({ topicTitle, articleTitle, digest, source, rank, draftId, style, humanScore }, cid = chatId) {
  const sourceEmoji = source === 'weibo' ? '🔥' : '🎵';
  const sourceName = source === 'weibo' ? '微博热搜' : '抖音热点';
  // 风格展示元数据（与 src/ai/generator.js 的 STYLE_LABELS 对齐）
  const STYLE_META = {
    default: { emoji: '📰', name: '爆款风格' },
    jaychou: { emoji: '🎵', name: '诗意叙事风' },
    sharp: { emoji: '⚡', name: '观点犀利风' },
    healing: { emoji: '🌿', name: '治愈温暖风' },
    knowledge: { emoji: '📚', name: '干货科普风' },
  };
  const styleMeta = STYLE_META[style] || STYLE_META.default;

  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '✅ 新文章已推送至草稿箱' },
      template: 'green',
    },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**来源**\n${sourceEmoji} ${sourceName} #${rank}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**热点话题**\n${topicTitle}` } },
        ],
      },
      { tag: 'hr' },
      { tag: 'div', text: { tag: 'lark_md', content: `**📝 文章标题**\n${articleTitle}` } },
      { tag: 'div', text: { tag: 'lark_md', content: `**摘要**\n${digest.slice(0, 100)}...` } },
      { tag: 'hr' },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**草稿ID**\n\`${draftId || '生成中...'}\`` } },
          { is_short: true, text: { tag: 'lark_md', content: `**文章风格**\n${styleMeta.emoji} ${styleMeta.name}` } },
          {
            is_short: true,
            text: {
              tag: 'lark_md',
              // 本地人味自检分，仅供参考（不等于检测平台结果）；偏低时建议人工再润色
              content: `**人味分**\n${typeof humanScore === 'number' ? `${humanScore} / 100` : '—'}`,
            },
          },
        ],
      },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '前往公众号草稿箱' }, type: 'primary', url: 'https://mp.weixin.qq.com' },
          { tag: 'button', text: { tag: 'plain_text', content: '用默认模式推送' }, type: 'default', value: { action: 'fetch_hot' } },
          { tag: 'button', text: { tag: 'plain_text', content: '🎵 用诗意叙事风推送' }, type: 'default', value: { action: 'fetch_jaychou' } },
        ],
      },
    ],
  };

  return sendMessage(cid, 'interactive', card);
}

// ===== 错误告警 =====
export async function sendErrorAlert(errorMsg, step, cid = chatId) {
  const card = {
    config: { wide_screen_mode: false },
    header: { title: { tag: 'plain_text', content: `❌ 流程异常: ${step}` }, template: 'red' },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**错误详情**\n\`\`\`\n${String(errorMsg).slice(0, 500)}\n\`\`\`` } },
    ],
  };
  return sendMessage(cid, 'interactive', card);
}

// ===== 说明 =====
// 指令解析与状态卡片已移除：
// Agent 模式下由 AI 直接理解自然语言，系统状态通过 get_system_status 工具返回，
// 不再需要单独的卡片渲染路径。
