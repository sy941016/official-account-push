/**
 * AI 文章生成模块
 * 支持 Claude (Anthropic) / OpenAI GPT / 豆包
 * 返回 { title, digest, contentHtml, keywords, imageQuery }
 */
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../utils/logger.js';

// ===== AI 客户端单例（懒加载，兼容 Node 14）=====
let _claudeClient = null;
let _openaiClient = null;

async function getClaudeClient() {
  if (!_claudeClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _claudeClient = new Anthropic({ apiKey: config.ai.anthropicKey });
  }
  return _claudeClient;
}

async function getOpenAIClient() {
  if (!_openaiClient) {
    const { default: OpenAI } = await import('openai');
    _openaiClient = new OpenAI({ apiKey: config.ai.openaiKey });
  }
  return _openaiClient;
}

const PROMPT_TEMPLATE = (topic) => `
你是一位资深的新媒体内容运营专家，擅长撰写微信公众号爆款文章。

请根据以下热点话题，写一篇高质量的公众号文章：

话题标题：${topic.title}
话题背景：${topic.summary}
话题来源：${topic.source === 'weibo' ? '微博热搜' : '抖音热点'}（热度排名第${topic.rank}位）

写作要求：
1. 标题：在原话题基础上优化，增加吸引力，不超过25个字
2. 正文字数：1200-1800字
3. 文章结构：引言 → 背景介绍 → 深度分析 → 多角度观点 → 总结展望
4. 语言风格：通俗易懂，有洞察力，有温度，避免说教
5. 适度加入数据/案例增强可信度
6. 结尾引导读者思考或互动

请以 JSON 格式输出，字段如下：
{
  "title": "优化后的文章标题",
  "digest": "文章摘要，50-100字，用于公众号摘要显示",
  "contentHtml": "文章正文HTML，使用<h2><p><strong><em><blockquote>等标签排版",
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "imageQuery": "用于搜索配图的英文关键词（2-4个词）"
}

只输出 JSON，不要有任何其他内容。
`.trim();

/**
 * 生成文章
 * @param {object} topic 标准化话题对象
 * @returns {Promise<object|null>}
 */
export async function generateArticle(topic) {
  logger.info(`AI生成文章：${topic.title}`);
  const prompt = PROMPT_TEMPLATE(topic);

  const provider = config.ai.provider;
  let raw = null;

  if (provider === 'claude') {
    raw = await generateWithClaude(prompt);
  } else if (provider === 'openai') {
    raw = await generateWithOpenAI(prompt);
  } else if (provider === 'doubao') {
    raw = await generateWithDoubao(prompt);
  } else {
    logger.error(`未知AI提供商: ${provider}`);
    return null;
  }

  if (!raw) return null;
  return parseResponse(raw);
}

// ===== Claude =====
async function generateWithClaude(prompt) {
  if (!config.ai.anthropicKey) {
    logger.error('ANTHROPIC_API_KEY 未配置');
    return null;
  }
  try {
    const client = await getClaudeClient();
    const msg = await client.messages.create({
      model: config.ai.claudeModel,
      max_tokens: 3000,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text || null;
  } catch (err) {
    logger.error(`Claude生成失败: ${err.message}`);
    return null;
  }
}

// ===== OpenAI =====
async function generateWithOpenAI(prompt) {
  if (!config.ai.openaiKey) {
    logger.error('OPENAI_API_KEY 未配置');
    return null;
  }
  try {
    const client = await getOpenAIClient();
    const res = await client.chat.completions.create({
      model: config.ai.openaiModel,
      messages: [
        { role: 'system', content: '你是专业的新媒体内容创作者，擅长写微信公众号文章。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 3000,
      temperature: 0.8,
    });
    return res.choices[0]?.message?.content || null;
  } catch (err) {
    logger.error(`OpenAI生成失败: ${err.message}`);
    return null;
  }
}

// ===== 豆包 AI =====
async function generateWithDoubao(prompt) {
  if (!config.ai.doubaoKey) {
    logger.error('DOUBAO_API_KEY 未配置');
    return null;
  }
  try {
    logger.info(`豆包API请求: 模型=${config.ai.doubaoModel}`);
    const response = await axios.post('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      model: config.ai.doubaoModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3000,
      temperature: 0.8,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.doubaoKey}`,
      },
      timeout: 120000, // 2分钟
    });

    const choice = response.data?.choices?.[0];
    logger.info(`豆包API响应: finish_reason=${choice?.finish_reason}, usage=${JSON.stringify(response.data?.usage)}`);
    return choice?.message?.content || null;
  } catch (err) {
    logger.error(`豆包生成失败: ${err.message}`);
    if (err.response) {
      logger.error(`响应状态: ${err.response.status}`);
      logger.error(`响应数据: ${JSON.stringify(err.response.data)}`);
    }
    return null;
  }
}

// ===== 解析响应 =====
function parseResponse(raw) {
  // 去掉 Markdown 代码块标记
  const cleaned = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  try {
    const data = JSON.parse(cleaned);
    const required = ['title', 'digest', 'contentHtml'];
    for (const field of required) {
      if (!data[field]) {
        logger.error(`AI响应缺少字段: ${field}`);
        return null;
      }
    }
    // 确保 contentHtml 有标签
    if (!data.contentHtml.startsWith('<')) {
      data.contentHtml = `<p>${data.contentHtml}</p>`;
    }
    logger.info(`文章生成成功：${data.title}`);
    return data;
  } catch (err) {
    logger.warn(`JSON解析失败，尝试容错解析: ${err.message}`);
    return fallbackParse(raw);
  }
}

function fallbackParse(raw) {
  const titleMatch = raw.match(/"title"\s*:\s*"([^"]+)"/);
  const digestMatch = raw.match(/"digest"\s*:\s*"([^"]+)"/);
  const title = titleMatch?.[1] || '热点文章';
  const digest = digestMatch?.[1] || '精彩内容等你来看';
  const paragraphs = raw.split('\n').filter(l => l.trim().length > 20).slice(0, 10);
  let contentHtml = paragraphs.map(p => `<p>${p.trim()}</p>`).join('') || '<p>内容生成中...</p>';
  // 添加固定作者信息
  contentHtml += '<p style="text-align: right; margin-top: 20px;">作者：可达鸭</p>';
  return { title, digest, contentHtml, keywords: [], imageQuery: 'news trending' };
}
