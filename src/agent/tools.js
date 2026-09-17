/**
 * Agent 工具注册表
 * 将现有功能模块封装为 Agent 可调用的工具
 * 每个工具包含：name, description, parameters (JSON Schema), execute 函数
 */

import config from '../../config/index.js';
import logger from '../utils/logger.js';

// ===== 工具内部引用（延迟导入避免循环依赖）=====
let _weiboCrawler = null;
let _douyinCrawler = null;
let _generator = null;
let _publisher = null;
let _feishuApp = null;

// ===== 运行时上下文（由 core.js 注入）=====
let _context = {
  stats: {},
  cachedTopics: [],
  onToolCall: null,  // 工具调用时的回调（用于向前端推送进度）
};

/** 把模型给的 topN 夹到合理区间，防止一次拉几百条把上下文撑爆 */
const clampTopN = (value, fallback, max) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
};

/**
 * 初始化工具上下文
 * @param {Object} context
 */
export function initToolContext(context) {
  _context = { ..._context, ...context };
}

// ===== 工具定义 =====

const toolDefinitions = [
  {
    name: 'crawl_weibo',
    description: '爬取微博热搜榜，返回当前最热门的话题列表（含排名、热度值、爆点标签如爆/沸/热/新）',
    parameters: {
      type: 'object',
      properties: {
        topN: {
          type: 'number',
          description: '获取前N条热搜，默认30',
        },
      },
      required: [],
    },
    execute: async ({ topN = 30 } = {}) => {
      if (!_weiboCrawler) {
        const mod = await import('../crawlers/weibo.js');
        _weiboCrawler = mod.getWeiboHot;
      }
      const topics = await _weiboCrawler(clampTopN(topN, 30, 50));
      // 更新缓存
      _context.cachedTopics = [
        ..._context.cachedTopics.filter(t => t.source !== 'weibo'),
        ...topics,
      ];
      // 返回精简格式给 Agent
      return topics.map(t => ({
        id: t.id,
        title: t.title,
        rank: t.rank,
        hotValue: t.hotValue,
        viralScore: t.viralScore,
        viralLabel: t.viralLabel,
        summary: t.summary,
        source: 'weibo',
      }));
    },
  },

  {
    name: 'crawl_douyin',
    description: '爬取抖音热点榜，返回当前最热门的话题列表（含排名、热度值、爆点标签）',
    parameters: {
      type: 'object',
      properties: {
        topN: {
          type: 'number',
          description: '获取前N条热点，默认20',
        },
      },
      required: [],
    },
    execute: async ({ topN = 20 } = {}) => {
      if (!_douyinCrawler) {
        const mod = await import('../crawlers/douyin.js');
        _douyinCrawler = mod.getDouyinHot;
      }
      const topics = await _douyinCrawler(clampTopN(topN, 20, 50));
      _context.cachedTopics = [
        ..._context.cachedTopics.filter(t => t.source !== 'douyin'),
        ...topics,
      ];
      return topics.map(t => ({
        id: t.id,
        title: t.title,
        rank: t.rank,
        hotValue: t.hotValue,
        viralScore: t.viralScore,
        viralLabel: t.viralLabel,
        summary: t.summary,
        source: 'douyin',
      }));
    },
  },

  {
    name: 'generate_article',
    description: '根据话题信息生成微信公众号文章。返回文章标题、摘要、HTML正文等。支持两种风格：default（爆款风格）和 jaychou（周杰伦情感风格）',
    parameters: {
      type: 'object',
      properties: {
        topicTitle: {
          type: 'string',
          description: '话题标题',
        },
        topicSummary: {
          type: 'string',
          description: '话题背景摘要或描述',
        },
        source: {
          type: 'string',
          enum: ['weibo', 'douyin', 'custom'],
          description: '话题来源平台，默认 weibo',
        },
        rank: {
          type: 'number',
          description: '话题排名，默认1',
        },
        style: {
          type: 'string',
          enum: ['default', 'jaychou'],
          description: '文章风格：default（爆款风格）或 jaychou（周杰伦情感风格），默认 default',
        },
      },
      required: ['topicTitle', 'topicSummary'],
    },
    execute: async ({ topicTitle, topicSummary, source = 'weibo', rank = 1, style }) => {
      if (!_generator) {
        const mod = await import('../ai/generator.js');
        _generator = mod.generateArticle;
      }

      const topic = {
        id: `agent_${Date.now()}`,
        title: topicTitle,
        summary: topicSummary,
        source,
        rank,
        hotValue: 0,
        viralScore: 0,
      };

      try {
        // 风格通过参数下发，不再改写全局 config（避免并发会话互相串台）
        const article = await _generator(topic, { style });
        if (!article) {
          return { success: false, error: '文章生成失败，AI 返回为空' };
        }
        return {
          success: true,
          title: article.title,
          digest: article.digest,
          contentHtml: article.contentHtml,
          keywords: article.keywords,
          imageQuery: article.imageQuery,
          style: article.style,
          // 本地人味自检分（0-100，越高越不像 AI）。用于向用户提示是否需要人工再润色
          humanScore: article.humanScore,
        };
      } catch (err) {
        return { success: false, error: `文章生成异常: ${err.message}` };
      }
    },
  },

  {
    name: 'publish_to_wechat',
    description:
      '将文章推送至微信公众号草稿箱。需要文章的标题、摘要和HTML正文。' +
      '如果是从 generate_article 拿到的结果，请把它的 imageQuery 一起传过来 —— ' +
      '这是英文配图关键词，用它去图库搜图效果远好于用中文标题',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '文章标题',
        },
        digest: {
          type: 'string',
          description: '文章摘要',
        },
        contentHtml: {
          type: 'string',
          description: '文章HTML正文',
        },
        imageQuery: {
          type: 'string',
          description: '配图搜索关键词（英文，2-4 个词），通常来自 generate_article 的返回值',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '文章关键词，没有 imageQuery 时会用它兜底搜图',
        },
      },
      required: ['title', 'digest', 'contentHtml'],
    },
    execute: async ({ title, digest, contentHtml, imageQuery, keywords }) => {
      if (!config.wechat.appId) {
        return { success: false, error: '微信公众号未配置 (WECHAT_APP_ID)' };
      }
      if (!_publisher) {
        const mod = await import('../wechat/publisher.js');
        _publisher = mod.publishToDraft;
      }
      try {
        const draftId = await _publisher({ title, digest, contentHtml, imageQuery, keywords });
        if (draftId) {
          return { success: true, draftId, message: `文章已推送至草稿箱，草稿ID: ${draftId}` };
        }
        return { success: false, error: '草稿创建失败，请检查微信公众号配置' };
      } catch (err) {
        return { success: false, error: `推送异常: ${err.message}` };
      }
    },
  },

  {
    name: 'send_feishu_notification',
    description: '通过飞书发送文本消息通知。可用于向指定群聊发送消息',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: '要发送的文本内容',
        },
        chatId: {
          type: 'string',
          description: '目标群聊ID（可选，不填则发送到默认群）',
        },
      },
      required: ['text'],
    },
    execute: async ({ text, chatId }) => {
      if (!config.feishu.appId) {
        return { success: false, error: '飞书未配置 (FEISHU_APP_ID)' };
      }
      if (!_feishuApp) {
        _feishuApp = await import('../feishu/app.js');
      }
      try {
        const ok = await _feishuApp.sendText(text, chatId || config.feishu.chatId);
        return ok
          ? { success: true, message: '飞书消息已发送' }
          : { success: false, error: '飞书消息发送失败' };
      } catch (err) {
        return { success: false, error: `飞书发送异常: ${err.message}` };
      }
    },
  },

  {
    name: 'get_system_status',
    description: '获取系统当前运行状态，包括今日发布数、累计发布数、AI提供商、定时任务配置等',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async () => {
      const stats = typeof _context.stats === 'function'
        ? _context.stats()
        : _context.stats;
      return {
        ...stats,
        articleStyle: config.articleStyle?.style || 'default',
        aiProvider: config.ai.provider,
        wechatConfigured: !!config.wechat.appId,
        feishuConfigured: !!config.feishu.appId,
        cachedTopicsCount: _context.cachedTopics.length,
      };
    },
  },

  {
    name: 'search_cached_topics',
    description: '在已缓存的热点话题中搜索。可按关键词或来源平台过滤',
    parameters: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: '搜索关键词（匹配标题），留空返回全部',
        },
        source: {
          type: 'string',
          enum: ['weibo', 'douyin', 'all'],
          description: '按来源平台过滤，默认 all',
        },
        limit: {
          type: 'number',
          description: '返回数量上限，默认10',
        },
      },
      required: [],
    },
    execute: async ({ keyword = '', source = 'all', limit = 10 } = {}) => {
      // 先拷贝，避免下面 sort 就地改写缓存数组
      let topics = [..._context.cachedTopics];

      // 来源过滤
      if (source !== 'all') {
        topics = topics.filter(t => t.source === source);
      }

      // 关键词过滤
      if (keyword) {
        const kw = keyword.toLowerCase();
        topics = topics.filter(t =>
          (t.title || '').toLowerCase().includes(kw) ||
          (t.summary || '').toLowerCase().includes(kw)
        );
      }

      // 按 viralScore 降序
      topics.sort((a, b) => (b.viralScore || 0) - (a.viralScore || 0));

      return topics.slice(0, clampTopN(limit, 10, 50)).map(t => ({
        id: t.id,
        title: t.title,
        rank: t.rank,
        viralScore: t.viralScore,
        viralLabel: t.viralLabel,
        summary: t.summary,
        source: t.source,
      }));
    },
  },
];

/**
 * 获取所有工具定义
 * @returns {Array}
 */
export function getToolDefinitions() {
  return toolDefinitions;
}

/**
 * 按名称查找并执行工具
 * @param {string} name 工具名
 * @param {Object} args 工具参数
 * @returns {Promise<any>} 工具执行结果
 */
export async function executeTool(name, args = {}) {
  const tool = toolDefinitions.find(t => t.name === name);
  if (!tool) {
    throw new Error(`未知工具: ${name}`);
  }

  // 通知回调（用于进度推送）
  if (_context.onToolCall) {
    _context.onToolCall(name, args);
  }

  logger.info(`Agent 调用工具: ${name}(${JSON.stringify(args).slice(0, 200)})`);
  try {
    const result = await tool.execute(args);
    logger.info(`工具 ${name} 执行完成`);
    return result;
  } catch (err) {
    logger.error(`工具 ${name} 执行失败: ${err.message}`);
    throw err;
  }
}
