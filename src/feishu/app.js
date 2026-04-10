/**
 * 飞书自建应用核心模块
 * - tenant_access_token 管理
 * - 发送消息卡片（文章通知、状态、告警）
 * - 指令解析
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
export async function sendArticleCard({ topicTitle, articleTitle, digest, source, rank, draftId, style }, cid = chatId) {
  const sourceEmoji = source === 'weibo' ? '🔥' : '🎵';
  const sourceName = source === 'weibo' ? '微博热搜' : '抖音热点';
  const styleEmoji = style === 'jaychou' ? '🎵' : '📰';
  const styleName = style === 'jaychou' ? '周杰伦歌曲' : '默认风格';

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
          { is_short: true, text: { tag: 'lark_md', content: `**文章风格**\n${styleEmoji} ${styleName}` } },
        ],
      },
      {
        tag: 'action',
        actions: [
          { tag: 'button', text: { tag: 'plain_text', content: '前往公众号草稿箱' }, type: 'primary', url: 'https://mp.weixin.qq.com' },
          { tag: 'button', text: { tag: 'plain_text', content: '用默认模式推送' }, type: 'default', value: { action: 'fetch_hot' } },
          { tag: 'button', text: { tag: 'plain_text', content: '🎵 用周杰伦歌曲推送' }, type: 'default', value: { action: 'fetch_jaychou' } },
        ],
      },
    ],
  };

  return sendMessage(cid, 'interactive', card);
}

// ===== 状态卡片 =====
export async function sendStatusCard(stats, cid = chatId) {
  const card = {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '📊 系统运行状态' }, template: 'blue' },
    elements: [
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**今日发布**\n${stats.todayCount ?? 0} 篇` } },
          { is_short: true, text: { tag: 'lark_md', content: `**累计发布**\n${stats.totalCount ?? 0} 篇` } },
        ],
      },
      {
        tag: 'div',
        fields: [
          { is_short: true, text: { tag: 'lark_md', content: `**最后运行**\n${stats.lastRun ?? '未运行'}` } },
          { is_short: true, text: { tag: 'lark_md', content: `**下次运行**\n${stats.nextRun ?? '未知'}` } },
        ],
      },
      {
        tag: 'div',
        text: { tag: 'lark_md', content: `**AI**: ${stats.aiProvider ?? '-'} | **图片**: ${stats.imageProvider ?? '-'} | **定时**: ${stats.cronSchedule ?? '-'}` },
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

// ===== 指令解析 =====
export function parseCommand(text) {
  const t = (text || '').trim().toLowerCase();

  // 推送文章（根据当前模式）
  if (['/push', '推送文章'].some(cmd => t.includes(cmd))) return 'FETCH_HOT';

  // 状态查询
  if (['/status', '状态', '/stat'].some(cmd => t.includes(cmd))) return 'STATUS';

  // 模式指令（显示当前模式）
  if (['/mode', '模式'].some(cmd => t.includes(cmd))) return 'MODE';

  // 数字切换模式指令
  if (t === '1') return 'MODE_1';
  if (t === '2') return 'MODE_2';

  // 帮助信息
  if (['/help', '帮助', '？', '?', 'help'].some(cmd => t.includes(cmd))) return 'HELP';

  return 'UNKNOWN';
}
