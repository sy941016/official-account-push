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

// ===== 系统人设提示词（默认风格 - 爆款专家）=====
const SYSTEM_PROMPT_DEFAULT = `你是一位拥有10年经验的微信公众号爆款内容创作专家，曾操盘多个百万粉丝账号。
你深刻理解中国新媒体读者的心理，擅长用情绪化叙事、悬念设置、共情表达抓住读者注意力。
你的文章总能引发大量转发和评论，因为你懂得在信息量与可读性之间找到完美平衡。

你写作时有鲜明的个人风格：
- 喜欢用"说真的""老实说""我当时看到这个消息"这类带个人色彩的口语自然引入
- 会适时表达自己的困惑或质疑，不装作什么都懂，偶尔说"我也没想明白"
- 用反问或感叹打断叙述节奏，让文字有呼吸感，不让人喘不过气
- 类比素材只从日常生活中取，绝不从教科书上搬概念
- 文章有个人温度，读者能感受到背后有一个真实的人在写字，而不是AI在输出
- 绝对不用"综上所述""不得不说""毋庸置疑"这类一眼就是AI的机械套话`;

// ===== 系统人设提示词（周杰伦歌曲 - 青春情感）=====
const SYSTEM_PROMPT_JAYCHOU = `你是一位深受周杰伦音乐影响的写作者，你的文字里藏着《晴天》的青涩、《七里香》的诗意、《稻香》的温暖、《告白气球》的甜蜜。
你擅长用歌词般的意境和旋律感的文字，讲述关于青春、爱情、回忆和成长的故事。

你的写作风格：
- 文字有画面感，像MV镜头一样切换场景：校园的操场、下雨的街角、老旧的收音机、泛黄的日记本
- 善用比喻，把抽象的情感具象化："思念像一阵风""回忆像一场雨""青春像一首唱不完的歌"
- 语言有韵律感，长短句交错，读起来像在听一首歌
- 情感真挚不矫情，有《简单爱》的纯粹，也有《搁浅》的遗憾
- 偶尔化用周杰伦经典歌词的意境，但不直接抄袭，而是用自己的话重新诠释那份感觉
- 不用说教，不讲大道理，只是安静地讲故事，让读者自己体会
- 拒绝AI腔调，不用"综上所述""不得不说"这类机械表达，保持文字的呼吸感和人情味`;

// ===== 默认风格 Prompt 模板 =====
const PROMPT_TEMPLATE_DEFAULT = (topic) => `
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

四、去AI味规范（极其重要，违反则文章作废）

【禁用词黑名单，以下词汇及句式一律不得出现】
× 总结套话：综上所述、总而言之、不得不说、毋庸置疑、值得注意的是、不禁让人深思、令人深思、不可忽视、不容小觑、由此可见、深刻揭示了、无不体现
× 开头套话：在当今社会、随着时代发展、近年来越来越多、众所周知、不言而喻
× 说教集体视角：我们不难发现、我们可以看到、让我们一起、可以预见的是、不难看出
× AI腔调词：毫无疑问、意义深远、引人深思、不禁感叹、值得深思、发人深省

【人性化写作要求】
- 至少使用2处第一人称口语：如"我觉得""老实说""说真的""坦白讲""说句实在的"
- 至少有1处表达不确定性：如"我也说不准""这只是我的猜测""也许吧""说不定"
- 段落长度参差不齐，有长有短，不能每段都差不多
- 用具体生活场景打比方，禁止纯粹抽象说理
- 允许有1-2处口语式转折，如"不过话说回来——"或"扯远了，回到正题"
- 文章中可自然出现1-2个语气词：啊、嘛、呢、吧（在段尾或口语句中使用，不滥用）

五、HTML排版（微信公众号专用，必须使用内联样式）
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

// ===== 周杰伦歌曲 Prompt 模板 =====
const PROMPT_TEMPLATE_JAYCHOU = (topic) => `
请根据以下话题，创作一篇充满周杰伦音乐风格的情感文章。

【话题信息】
主题：${topic.title}
背景：${topic.summary}

【写作要求】

一、标题（必须满足以下至少2条）
- 不超过25个字，有诗意或画面感
- 像一首歌的名字，让人想点进去听这个故事
- 可以化用周杰伦歌曲的意境：如"晴天""七里香""稻香""简单爱""星晴""彩虹"
- 引发情感共鸣，关于青春、爱情、回忆或成长

二、正文结构（1200-1800字）

文章要像一首周杰伦的歌，有前奏、主歌、副歌、桥段、尾奏：

1. 【前奏】开篇意境（100-150字）
   - 用一个具体场景开篇：下雨的午后、放学的铃声、深夜的耳机、旧照片
   - 营造氛围，像MV的第一个镜头，让读者瞬间进入情绪

2. 【主歌A段】故事展开（250-350字）
   - 讲述一个具体的故事或回忆，有细节、有画面
   - 可以是对话题的个人化解读，融入真实的生活场景
   - 用"那时候""还记得""曾经"等词营造时光感

3. 【主歌B段】情感深化（250-350字）
   - 深入挖掘情感层面，不只是讲故事，而是讲感受
   - 用比喻把抽象情感具象化：思念像什么、遗憾像什么、青春像什么
   - 可以引用或化用周杰伦歌词的意境，但用自己的话表达

4. 【副歌】情感高潮（300-400字）
   - 文章最动人的部分，金句集中地
   - 用排比、反复等手法制造旋律感
   - 表达核心情感：爱、遗憾、怀念、成长、告别
   - 让读者读完这一段，脑子里像响起一首歌

5. 【桥段】思考与转折（200-250字）
   - 从个人故事延伸到普遍情感
   - 可以有一点哲思，但保持温柔，不说教
   - 像歌曲中间的间奏，情绪稍微沉淀

6. 【尾奏】余韵留白（100-150字）
   - 不强行总结，而是留一个画面或一个问题
   - 让读者读完之后，还想再听一遍"这首歌"
   - 可以用一句歌词化的句子结尾

三、语言风格（周杰伦音乐感）
- 文字要有画面感：街角的咖啡店、窗外的麻雀、泛黄的信纸、单车后座
- 善用自然意象：风、雨、阳光、星空、稻田、彩虹、晴天
- 句子长短交错，有节奏感，像歌词一样
- 情感真挚，不矫情，有《简单爱》的纯粹，也有《搁浅》的遗憾
- 不用复杂的修辞，但要有诗意，像"最美的不是下雨天，是曾与你躲过雨的屋檐"

四、去AI味规范（极其重要）

【绝对禁止的AI腔调】
× 综上所述、总而言之、不得不说、毋庸置疑
× 值得注意的是、不禁让人深思、令人深思
× 在当今社会、随着时代发展、众所周知
× 我们不难发现、我们可以看到、不难看出
× 毫无疑问、意义深远、引人深思、发人深省

【人性化要求】
- 像写给老朋友的一封信，不是论文
- 段落长短不一，有呼吸感
- 可以用"那时候""你知道吗""说实话"这类口语
- 允许有1-2处语气词：啊、呢、吧、嘛
- 表达可以有点不确定，"也许吧""谁知道呢"

五、HTML排版（微信公众号专用，必须使用内联样式）
- 段落：<p style="margin: 16px 0; line-height: 1.8; font-size: 16px; color: #333;">
- 小标题（用歌词感）：<h2 style="font-size: 18px; font-weight: bold; color: #1a1a1a; margin: 28px 0 12px; border-left: 4px solid #07C160; padding-left: 12px; font-style: italic;">
- 重点词：<strong style="color: #e04040;">
- 金句/歌词引用：<blockquote style="border-left: 3px solid #07C160; margin: 20px 0; padding: 12px 16px; background: #f9f9f9; color: #555; font-style: italic;">
- 意境词：<span style="color: #07C160; font-weight: bold;">

请以 JSON 格式输出，字段如下：
{
  "title": "诗意化的标题，像一首歌的名字（不超过25字）",
  "digest": "文章摘要，60-100字，像歌词一样优美，引发情感共鸣",
  "contentHtml": "完整文章正文HTML，必须使用上述内联样式规范",
  "keywords": ["核心关键词1", "关键词2", "关键词3"],
  "imageQuery": "用于搜索配图的英文关键词，偏向意境场景如 sunset, rain, nostalgia"
}

只输出 JSON，不要有任何其他内容。
`.trim();

// ===== 文章尾部固定内容 =====
const ARTICLE_FOOTER = `
<p style="margin: 40px 0 8px; text-align: center; color: #999; font-size: 14px;">— END —</p>
<p style="margin: 8px 0 24px; text-align: center; color: #999; font-size: 13px;">觉得有用？点个<strong style="color: #e04040;">在看</strong>支持一下 👇</p>
`.trim();

// ===== AI套话替换词典（去AI味后处理）=====
const AI_PHRASE_MAP = [
  // 总结套话
  [/综上所述[，,]?\s*/g, '说到这里，'],
  [/总而言之[，,]?\s*/g, '总的来说吧，'],
  [/不得不说[，,]?\s*/g, '说真的，'],
  [/毋庸置疑[，,]?\s*/g, ''],
  [/值得注意的是[，,]?\s*/g, '有一点要说一下，'],
  [/不禁让人深思[。？]?\s*/g, '这事儿值得琢磨。'],
  [/令人深思[。，,]?\s*/g, '挺有意思的。'],
  [/不可忽视的是[，,]?\s*/g, ''],
  [/不容小觑[。，,]?\s*/g, ''],
  [/由此可见[，,]?\s*/g, '所以嘛，'],
  [/深刻揭示了/g, '说明了'],
  [/无不体现/g, '都显示出'],
  // 开头套话
  [/在当今社会[，,]?\s*/g, '现在这个时候，'],
  [/随着时代的?发展[，,]?\s*/g, '现在嘛，'],
  [/众所周知[，,]?\s*/g, '大家都知道，'],
  [/不言而喻[，,]?\s*/g, '很明显，'],
  // 说教集体视角
  [/我们不难发现[，,]?\s*/g, '可以看出，'],
  [/我们可以看到[，,]?\s*/g, '能看出来，'],
  [/让我们一起\s*/g, ''],
  [/可以预见的是[，,]?\s*/g, '估计'],
  [/不难看出[，,]?\s*/g, '说白了，'],
  // AI腔调词
  [/毫无疑问[，,]?\s*/g, '说真的，'],
  [/意义深远[。，,]?\s*/g, '影响不小。'],
  [/引人深思[。，,]?\s*/g, '值得想想。'],
  [/不禁感叹[，,]?\s*/g, '真的感慨，'],
  [/值得深思[。，,]?\s*/g, '挺值得想想的。'],
  [/发人深省[。，,]?\s*/g, '让人有点触动。'],
];

/**
 * 获取当前使用的系统提示词
 * @returns {string}
 */
function getSystemPrompt() {
  const style = config.articleStyle?.style || 'default';
  if (style === 'jaychou') {
    return SYSTEM_PROMPT_JAYCHOU;
  }
  return SYSTEM_PROMPT_DEFAULT;
}

/**
 * 获取当前使用的Prompt模板
 * @param {object} topic 话题对象
 * @returns {string}
 */
function getPromptTemplate(topic) {
  const style = config.articleStyle?.style || 'default';
  if (style === 'jaychou') {
    return PROMPT_TEMPLATE_JAYCHOU(topic);
  }
  return PROMPT_TEMPLATE_DEFAULT(topic);
}

/**
 * 生成文章
 * @param {object} topic 标准化话题对象
 * @returns {Promise<object|null>}
 */
export async function generateArticle(topic) {
  const style = config.articleStyle?.style || 'default';
  logger.info(`AI生成文章[风格:${style}]：${topic.title}`);
  
  const systemPrompt = getSystemPrompt();
  const prompt = getPromptTemplate(topic);

  const provider = config.ai.provider;
  let raw = null;

  if (provider === 'claude') {
    raw = await generateWithClaude(prompt, systemPrompt);
  } else if (provider === 'openai') {
    raw = await generateWithOpenAI(prompt, systemPrompt);
  } else if (provider === 'doubao') {
    raw = await generateWithDoubao(prompt, systemPrompt);
  } else {
    logger.error(`未知AI提供商: ${provider}`);
    return null;
  }

  if (!raw) return null;
  return parseResponse(raw);
}

// ===== Claude =====
async function generateWithClaude(prompt, systemPrompt) {
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
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    });
    return msg.content[0]?.text || null;
  } catch (err) {
    logger.error(`Claude生成失败: ${err.message}`);
    return null;
  }
}

// ===== OpenAI =====
async function generateWithOpenAI(prompt, systemPrompt) {
  if (!config.ai.openaiKey) {
    logger.error('OPENAI_API_KEY 未配置');
    return null;
  }
  try {
    const client = await getOpenAIClient();
    const res = await client.chat.completions.create({
      model: config.ai.openaiModel,
      messages: [
        { role: 'system', content: systemPrompt },
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
async function generateWithDoubao(prompt, systemPrompt) {
  if (!config.ai.doubaoKey) {
    logger.error('DOUBAO_API_KEY 未配置');
    return null;
  }
  try {
    logger.info(`豆包API请求: 模型=${config.ai.doubaoModel}`);
    const response = await axios.post('https://ark.cn-beijing.volces.com/api/v3/chat/completions', {
      model: config.ai.doubaoModel,
      messages: [
        { role: 'system', content: systemPrompt },
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
 * 去AI味后处理：替换常见AI套话为口语化表达
 * @param {string} html 原始 HTML 内容
 * @returns {string} 处理后的 HTML 内容
 */
function humanizeContent(html) {
  let result = html;
  let replacedCount = 0;
  for (const [pattern, replacement] of AI_PHRASE_MAP) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) replacedCount++;
  }
  if (replacedCount > 0) {
    logger.info(`去AI味处理：替换了 ${replacedCount} 处AI套话`);
  }
  return result;
}

/**
 * 文章后处理：去AI味 + 质量校验 + 统一注入尾部内容
 */
function postProcess(data) {
  // 确保 contentHtml 有标签
  if (!data.contentHtml.startsWith('<')) {
    data.contentHtml = `<p style="margin:16px 0;line-height:1.8;font-size:16px;color:#333;">${data.contentHtml}</p>`;
  }

  // 去AI味后处理
  data.contentHtml = humanizeContent(data.contentHtml);
  data.digest = humanizeContent(data.digest);

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
