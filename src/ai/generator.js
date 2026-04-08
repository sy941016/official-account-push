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

// ===== 系统人设提示词（所有模型通用）=====
const SYSTEM_PROMPT = `你是一位拥有10年经验的微信公众号爆款内容创作专家，曾操盘多个百万粉丝账号。
你深刻理解中国新媒体读者的心理，擅长用情绪化叙事、悬念设置、共情表达抓住读者注意力。
你的文章总能引发大量转发和评论，因为你懂得在信息量与可读性之间找到完美平衡。`;

// ===== 核心 Prompt 模板 =====
const PROMPT_TEMPLATE = (topic) => `
请根据以下热点话题，创作一篇高质量的微信公众号爆款文章。

【话题信息】
标题：${topic.title}
背景：${topic.summary}
来源：${topic.source === 'weibo' ? '微博热搜' : '抖音热点'}（热度排名第${topic.rank}位）

【写作要求】

一、标题（必须满足以下至少3条）
- 不超过25个字
- 制造好奇心或悬念（如：没想到、竟然、真相是）
- 或者引发情感共鸣（触动、扎心、破防）
- 或者提供明确价值（干货、必看、深度）
- 禁止使用夸大不实的标题党

二、正文结构（1500-2200字）
1. 开篇钩子（100-150字）：用一个强烈的场景、反差或灵魂拷问开篇，让读者立刻停止划走
2. 事件背景（200-300字）：简洁交代来龙去脉，配合数据/时间线增强真实感
3. 深度拆解（500-700字）：至少从2个不同角度深度分析，提出独到见解，非人云亦云
4. 真实案例或数据（200-300字）：引用具体数字、真实案例或权威观点佐证论点
5. 读者共鸣层（200-300字）：将话题与普通人的日常生活/情感连接，引发"这说的就是我"的共鸣
6. 结尾互动（100-150字）：留下开放性问题或行动号召，引导评论和转发

三、语言风格
- 口语化、有温度，像朋友聊天不像论文
- 适当使用短句和独立成段制造节奏感
- 关键观点用加粗或引用块突出
- 禁止：说教式口吻、大量专业术语堆砌、空洞的正确废话

四、HTML排版（微信公众号专用，必须使用内联样式）
- 段落：<p style="margin: 16px 0; line-height: 1.8; font-size: 16px; color: #333;">
- 小标题：<h2 style="font-size: 20px; font-weight: bold; color: #1a1a1a; margin: 28px 0 12px; border-left: 4px solid #07C160; padding-left: 12px;">
- 重点词：<strong style="color: #e04040;">
- 金句引用：<blockquote style="border-left: 3px solid #07C160; margin: 20px 0; padding: 12px 16px; background: #f9f9f9; color: #555; font-style: italic;">
- 数据高亮：<span style="color: #07C160; font-weight: bold;">

请以 JSON 格式输出，字段如下：
{
  "title": "优化后的爆款标题（不超过25字）",
  "digest": "文章摘要，60-100字，突出亮点，吸引点击，用于公众号摘要显示",
  "contentHtml": "完整文章正文HTML，必须使用上述内联样式规范",
  "keywords": ["核心关键词1", "关键词2", "关键词3"],
  "imageQuery": "用于搜索配图的英文关键词，2-4个词，偏向具体场景而非抽象概念"
}

只输出 JSON，不要有任何其他内容。
`.trim();

// ===== 文章尾部固定内容 =====
const ARTICLE_FOOTER = `
<p style="margin: 40px 0 8px; text-align: center; color: #999; font-size: 14px;">— END —</p>
<p style="margin: 8px 0 24px; text-align: center; color: #999; font-size: 13px;">觉得有用？点个<strong style="color: #e04040;">在看</strong>支持一下 👇</p>
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
      max_tokens: 4096,
      temperature: 0.85,
      system: SYSTEM_PROMPT,
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
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
      temperature: 0.85,
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
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
      temperature: 0.85,
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.ai.doubaoKey}`,
      },
      timeout: 600000, // 10分钟
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
    return postProcess(data);
  } catch (err) {
    logger.warn(`JSON解析失败，尝试容错解析: ${err.message}`);
    return fallbackParse(raw);
  }
}

/**
 * 文章后处理：质量校验 + 统一注入尾部内容
 */
function postProcess(data) {
  // 确保 contentHtml 有标签
  if (!data.contentHtml.startsWith('<')) {
    data.contentHtml = `<p style="margin:16px 0;line-height:1.8;font-size:16px;color:#333;">${data.contentHtml}</p>`;
  }

  // 注入统一尾部（避免重复注入）
  if (!data.contentHtml.includes('— END —')) {
    data.contentHtml = data.contentHtml + '\n' + ARTICLE_FOOTER;
  }

  // 标题长度校验
  if (data.title.length > 25) {
    logger.warn(`标题超长(${data.title.length}字)，已截断: ${data.title}`);
    data.title = data.title.slice(0, 25);
  }

  // 正文字数估算（去除 HTML 标签后）
  const textContent = data.contentHtml.replace(/<[^>]+>/g, '');
  const charCount = textContent.replace(/\s/g, '').length;
  if (charCount < 800) {
    logger.warn(`文章正文字数偏少(约${charCount}字)，质量可能不足`);
  } else {
    logger.info(`文章生成成功：${data.title}（约${charCount}字）`);
  }

  // 确保 keywords 是数组
  if (!Array.isArray(data.keywords)) {
    data.keywords = [];
  }

  return data;
}

function fallbackParse(raw) {
  const titleMatch = raw.match(/"title"\s*:\s*"([^"]+)"/);
  const digestMatch = raw.match(/"digest"\s*:\s*"([^"]+)"/);
  const title = titleMatch?.[1] || '热点文章';
  const digest = digestMatch?.[1] || '精彩内容等你来看';
  const paragraphs = raw.split('\n').filter(l => l.trim().length > 20).slice(0, 10);
  let contentHtml = paragraphs
    .map(p => `<p style="margin:16px 0;line-height:1.8;font-size:16px;color:#333;">${p.trim()}</p>`)
    .join('') || '<p style="margin:16px 0;line-height:1.8;font-size:16px;color:#333;">内容生成中...</p>';
  contentHtml += '\n' + ARTICLE_FOOTER;
  return { title, digest, contentHtml, keywords: [], imageQuery: 'news trending' };
}
