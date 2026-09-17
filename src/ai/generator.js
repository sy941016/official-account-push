/**
 * AI 文章生成模块
 * 支持 Claude (Anthropic) / OpenAI GPT / 豆包，统一走 ../ai/client.js
 * 返回 { title, digest, contentHtml, keywords, imageQuery, humanScore }
 *
 * 风格通过参数传入（options.style），不再读写全局 config.articleStyle，
 * 避免两个会话同时要求不同风格时互相串台。
 *
 * 关于"反 AI 检测"（v2.2 重做）：
 * 朱雀这类检测器判定的是统计分布，不是字面用词，所以旧版那张"禁用词黑名单"作用有限。
 * 现在的做法是三层：
 *   ① 提示词层：给模型正向节奏范文 + 可被程序检查的量化硬指标（见 ANTI_DETECT_RULES）
 *   ② 后处理层：清套话 + 打散长段落，制造段落参差（src/ai/humanize.js）
 *   ③ 自检层：生成后本地打分，不达标就带着问题清单重写一轮
 * 具体原理见 src/ai/humanize.js 的文件头注释。
 */
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/helpers.js';
import { chat } from './client.js';
import {
  HUMANITY_TARGETS,
  buildRewriteInstruction,
  flagUntraceableSpecifics,
  humanizeContent,
  restructureParagraphs,
  scoreHumanity,
} from './humanize.js';

export const ARTICLE_STYLES = ['default', 'jaychou'];

// ===== 节奏参照范文 =====
// 给模型一段"目标质感"的样本，比列一堆禁用词有效得多：
// 禁用词表只告诉模型"别写什么"，范文告诉它"该是什么节奏"。
// 这是提示词里性价比最高的一块，别删。
const RHYTHM_SAMPLE_DEFAULT = `说真的，我第一反应是"这也能上热搜？"。

点进去看了半小时，越看越不对劲。

事情的起点其实很小——上周三，杭州一个姑娘在小区群里发了张照片，说她家楼下那家开了十二年的面馆，突然贴了张纸，写着"本店转让"。就这么一张 A4 纸，被人拍下来发到网上，一天之内转了两万多条。

我翻评论区翻到凌晨，发现大家聊的根本不是面馆。有人在说小时候巷口那家馄饨摊，有人在说大学后门那个总多给一勺汤的老板娘。

扯远了，回到正题：为什么一家普通面馆关门，能让两万人集体破防？

我猜大概是因为——它太普通了。普通到我们每个人都有一家。

它关门的时候你甚至不在场，等你回去，那条街已经换成奶茶店了。`;

const RHYTHM_SAMPLE_JAYCHOU = `那年的雨下得很突然。

放学铃响的时候天还是晴的。等我推着单车走出校门，雨已经砸下来了，砸在车筐里那本卷了边的歌词本上。

我躲进街角那家音像店。老板正在放一首老歌，前奏一出来，整个屋子的空气都慢了下来。玻璃门外的雨帘、货架上落了灰的磁带、柜台后面那台老式收音机——这些画面我记了快二十年。

后来我才明白，我记得的其实不是那场雨。

是那天谁也没有先走。

有些人就是这样，在你的青春里待了三年，然后用二十年让你慢慢忘记。忘不掉的也不是人，是那时候的自己——还会为一场雨停下来，还会觉得一首歌能唱一辈子。`;

/**
 * 反 AI 检测规范（两种风格共用，只替换节奏范文）
 * 指标数值直接引用 HUMANITY_TARGETS，保证"提示词要求"和"自检打分"永远对得上，
 * 不会出现改了阈值却忘了改提示词的情况。
 */
function buildAntiDetectRules(sample) {
  const T = HUMANITY_TARGETS;
  return `
【反 AI 检测规范 · 最重要的一节，违反则整篇作废】

先说原理，理解了才写得对：检测系统（如腾讯朱雀）判定的是**统计分布**，不是字面用词。
它主要看三件事：① 用词有多容易被预测（困惑度）；② 句子和段落的长度是否过于规律；
③ 大模型偏爱的套话词频。
所以"把'首先'改成'第一个方面'、把'因此'换成'所以'"这种同义词替换**完全无效**——
分布没变，照样被识别。真正有效的是改变**写作节奏**，下面每条都是可被程序检查的硬指标。

【必须满足的硬指标】
1. 句长剧烈波动：句长标准差/均值 ≥ ${T.sentenceLenCV}。
   全文至少 3 句不超过 8 个字（如"就这么简单。""我也说不准。"），
   同时至少 2 句超过 45 个字。
2. 段落长短悬殊：最短段 ≤35 字，最长段 ≥180 字，段落长度变异系数 ≥ ${T.paraLenCV}。
3. 不少于 2 个段落只有一句话，单独成段。
4. 至少 3 处具体的细节：具体日期、具体金额、具体地名、具体品牌或型号、某个人说的话。
   **但"具体"绝不等于"编造"**：【话题信息】里没有给你、你自己也不确定的数字 / 时间 /
   价格 / 当事人原话，**一律不要写**。凑不够 3 处就少写几处——**编造比不够具体严重得多**。
   尤其禁止虚构引号里的原话，再安到某个真实存在的人或机构头上（某位博主、某家公司）。
   不确定的时候，把细节落在场景和感受上（"我盯着那个画面看了很久"）是完全可以的。
   真实感来自"确定的就写确定、不确定的就不写"，不来自数字和引号的密度。
5. 至少 1 处自我修正，如"……不对，准确说是……"或"我一开始以为是 X，后来发现不是"。
6. 至少 1 处跑题再拉回，如"扯远了，回到正题"。
7. 标点至少混用其中 3 种：破折号（——）、省略号（……）、问号（？）、引号（""）、括号（（））。
8. 至少 4 处口语标记：我觉得 / 其实 / 说白了 / 说真的 / 我猜 / 问题是 / 反正 之类；
   句尾可自然带语气词：啊、嘛、呢、吧。
9. 允许 1-2 处"不完美"：口语式重复（"很普通，真的很普通"）、半截话、突然的短句打断。

【绝对禁止】
× 排比、对仗、"首先…其次…最后"、"一方面…另一方面"、"从 X 角度看…从 Y 角度看"
× 连续三句话长度接近，或开头结构相同
× 每段都写成"观点 + 例子 + 小结"的完整闭环
× 在当今社会 / 随着时代发展 / 综上所述 / 总而言之 / 值得注意的是 / 不得不说 /
  毋庸置疑 / 由此可见 / 不难看出 / 毫无疑问 / 令人深思 / 意义深远
× 每段开头都是结构完整的陈述长句

【节奏参照 · 目标就是这种质感】
${sample}

注意：上面只是**节奏样例**，不是要你复述它的内容。你要写的是给定话题，
但句子长短的落差、段落的参差程度、具体细节的密度、口语的自然感，要达到同样的水平。
`.trim();
}

// ===== 系统人设提示词（默认风格 - 爆款专家）=====
const SYSTEM_PROMPT_DEFAULT = `你是一位拥有10年经验的微信公众号爆款内容创作专家，曾操盘多个百万粉丝账号。
你深刻理解中国新媒体读者的心理，擅长用情绪化叙事、悬念设置、共情表达抓住读者注意力。

但你和那些"AI 味十足"的同行最大的区别在于：你写的东西读起来像**一个人在跟你说话**，
而不是一篇文章在跟你汇报。你的句子忽长忽短，段落有的只有一行，有的铺得很长。
你会突然插一句自己的感受，会承认自己也没想明白，会跑题一句再自己拉回来。

${buildAntiDetectRules(RHYTHM_SAMPLE_DEFAULT)}`;

// ===== 系统人设提示词（周杰伦歌曲 - 青春情感）=====
const SYSTEM_PROMPT_JAYCHOU = `你是一位深受周杰伦音乐影响的写作者，你的文字里藏着《晴天》的青涩、《七里香》的诗意、《稻香》的温暖。
你擅长用歌词般的意境和旋律感的文字，讲述关于青春、爱情、回忆和成长的故事。

你的文字像一个人坐在你对面慢慢讲，不像一篇文章在朗读。该短的地方就一句话，
该停的地方就留白，偶尔会突然想起一个细节，然后自己愣一下。

${buildAntiDetectRules(RHYTHM_SAMPLE_JAYCHOU)}`;

/**
 * 拼【背景】行。
 * 有些数据源确实拿不到任何背景（如微博网页兜底、微博官方接口的 note 就是标题本身）。
 * 这时宁可不输出这一行，也不要留一个空的"背景："，更不能把标题原样再贴一遍——
 * 模型看到重复的字符串，会以为那就是它该展开的背景信息。
 */
function backgroundLine(summary) {
  const text = String(summary ?? '').trim();
  return text ? `\n背景：${text}` : '';
}

// ===== 默认风格 Prompt 模板 =====
const PROMPT_TEMPLATE_DEFAULT = (topic) => `
请根据以下热点话题，创作一篇高质量的微信公众号爆款文章。

【话题信息】
标题：${topic.title}${backgroundLine(topic.summary)}
来源：${topic.source === 'weibo' ? '微博热搜' : topic.source === 'douyin' ? '抖音热点' : '自定义话题'}（热度排名第${topic.rank}位）

【写作要求】

一、标题（必须满足以下至少3条）
- 不超过25个字
- 制造好奇心或悬念（如：没想到、竟然、真相是）
- 或者引发情感共鸣（触动、扎心、破防）
- 或者提供明确价值（干货、必看、深度）
- 禁止使用夸大不实的标题党

二、正文（1500-2200字）
不要写成"开篇钩子 → 背景 → 分析 → 案例 → 共鸣 → 结尾"的整齐六段式——那是最典型的 AI 结构。
按下面的**内容重心**来组织，但段落怎么切、哪里长哪里短，由你按反 AI 检测规范自己判断：
1. 用具体的场景、反差或一句灵魂拷问开头，让读者立刻停下划动的手
2. 交代来龙去脉时给出真实的时间线和数字，不要泛泛而谈
3. 至少从 2 个不同角度做深度拆解，提出独到见解，别复述网上已有的观点
4. 用具体的案例或数据佐证，最好是能落到某个人、某一天、某个数字上的
5. 把话题和普通人的日常连接起来，让读者产生"这说的就是我"的感觉
6. 结尾留一个开放性问题或行动号召，但**不要**做总结陈词

三、语言风格
- 口语化、有温度，像朋友聊天，不像论文也不像新闻稿
- 关键观点用 <strong> 或 <blockquote> 突出，但不要每段都突出

四、HTML排版（微信公众号专用，必须使用内联样式）
- 段落：<p style="margin: 16px 0; line-height: 1.8; font-size: 16px; color: #333;">
- 小标题：<h2 style="font-size: 20px; font-weight: bold; color: #1a1a1a; margin: 28px 0 12px; border-left: 4px solid #07C160; padding-left: 12px;">
- 重点词：<strong style="color: #e04040;">
- 金句引用：<blockquote style="border-left: 3px solid #07C160; margin: 20px 0; padding: 12px 16px; background: #f9f9f9; color: #555; font-style: italic;">
- 数据高亮：<span style="color: #07C160; font-weight: bold;">
- 小标题控制在 3-5 个，不要更多；单句成段的那种段落**不要**加小标题

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
主题：${topic.title}${backgroundLine(topic.summary)}

【写作要求】

一、标题（必须满足以下至少2条）
- 不超过25个字，有诗意或画面感
- 像一首歌的名字，让人想点进去听这个故事
- 可以化用周杰伦歌曲的意境：如"晴天""七里香""稻香""简单爱""星晴""彩虹"
- 引发情感共鸣，关于青春、爱情、回忆或成长

二、正文（1200-1800字）
文章要有前奏、主歌、副歌、桥段、尾奏的**情绪起伏**，但不要机械地给每部分加小标题，
更不要写成整齐的五段式。情绪推上去的地方可以铺很长，情绪落下来的地方就该只有一句话。
1. 用一个具体场景开篇：下雨的午后、放学的铃声、深夜的耳机、旧照片
2. 讲一个具体的故事或回忆，要有细节、有画面，细节要具体到时间、地点、物件
3. 往情感层面挖，不只是讲故事，而是讲感受，用比喻把抽象的情感具象化
4. 情绪高潮部分：可以用排比以外的反复手法（短句重复、意象回环）制造旋律感，
   但**禁止**结构工整的排比句
5. 桥段从个人故事延伸到普遍情感，可以有一点哲思，但保持温柔，不说教
6. 结尾不要总结，留一个画面或一个问题，让读者读完还想再听一遍"这首歌"

三、语言风格（周杰伦音乐感）
- 文字有画面感：街角的咖啡店、窗外的麻雀、泛黄的信纸、单车后座
- 善用自然意象：风、雨、阳光、星空、稻田、彩虹、晴天
- 句子长短交错，有节奏感，像歌词一样
- 情感真挚不矫情，有《简单爱》的纯粹，也有《搁浅》的遗憾

四、HTML排版（微信公众号专用，必须使用内联样式）
- 段落：<p style="margin: 16px 0; line-height: 1.8; font-size: 16px; color: #333;">
- 小标题（用歌词感）：<h2 style="font-size: 18px; font-weight: bold; color: #1a1a1a; margin: 28px 0 12px; border-left: 4px solid #07C160; padding-left: 12px; font-style: italic;">
- 重点词：<strong style="color: #e04040;">
- 金句/歌词引用：<blockquote style="border-left: 3px solid #07C160; margin: 20px 0; padding: 12px 16px; background: #f9f9f9; color: #555; font-style: italic;">
- 意境词：<span style="color: #07C160; font-weight: bold;">
- 小标题控制在 3-4 个，不要更多

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

const BODY_P_STYLE = 'margin:16px 0;line-height:1.8;font-size:16px;color:#333;';

/** 归一化风格名，非法值回退到默认风格 */
export function normalizeStyle(style) {
  return ARTICLE_STYLES.includes(style) ? style : 'default';
}

function getSystemPrompt(style) {
  return style === 'jaychou' ? SYSTEM_PROMPT_JAYCHOU : SYSTEM_PROMPT_DEFAULT;
}

function getPromptTemplate(topic, style) {
  return style === 'jaychou' ? PROMPT_TEMPLATE_JAYCHOU(topic) : PROMPT_TEMPLATE_DEFAULT(topic);
}

/**
 * 生成文章
 *
 * 流程：生成 → 解析 → 后处理（去AI味 + 段落打散）→ 本地打分 →
 *       分数不达标且还有重写轮次，则带着问题清单再生成一次，取分高的那版。
 *
 * @param {object} topic 标准化话题对象
 * @param {object} [options]
 * @param {'default'|'jaychou'} [options.style] 文章风格，缺省时用 config.articleStyle.style
 * @returns {Promise<object|null>} 失败返回 null（调用方无需处理异常）
 */
export async function generateArticle(topic, options = {}) {
  const style = normalizeStyle(options.style || config.articleStyle?.style);
  // 这里的兜底默认值必须和 config/index.js 里的默认值**逐项对齐**。
  // config 才是唯一来源，这几个默认值只在"配置对象缺键"时兜底——
  // 两边一旦不一致，表现就是"设置静默失效"（比如旧进程里 rewriteRounds 会退化成 0，
  // 重写循环直接不跑，而且不报任何错），非常难查。
  const {
    minHumanScore = 70,
    rewriteRounds = 1,
    temperature = 0.9,
    maxTokens = 4096,
    totalBudgetMs = 600_000,
  } = config.articleStyle || {};

  logger.info(`AI生成文章[风格:${style}]：${topic.title}`);

  // 整篇文章的截止时刻。流水线是串行的，一篇卡住的文章会挤掉后面所有话题，
  // 所以必须有硬上限，不能让"单次超时 × 重试 × 重写"自由相乘。
  const deadline = Date.now() + totalBudgetMs;

  let best = null;
  let feedback = '';

  for (let attempt = 0; attempt <= Math.max(0, rewriteRounds); attempt++) {
    // 已经超预算就不再开新一轮重写。手里有 best 就交出去，没有就返回 null 让选题被跳过——
    // 两者都比继续耗着强。
    if (attempt > 0 && Date.now() >= deadline) {
      logger.warn(
        `单篇预算 ${Math.round(totalBudgetMs / 1000)}s 已用尽，放弃第 ${attempt + 1} 轮重写` +
          (best ? `，保留已生成的 ${best.article.humanScore} 分版本` : '')
      );
      break;
    }
    let raw = null;
    try {
      raw = await withRetry(
        async () => {
          const res = await chat({
            system: getSystemPrompt(style),
            messages: [{ role: 'user', content: buildUserPrompt(topic, style, feedback) }],
            temperature,
            maxTokens,
            // 压低"最保险的用词"的重复率，是降低文本可预测性最直接的两个旋钮。
            // Claude 协议不支持，client.js 会自动忽略。
            frequencyPenalty: config.ai.frequencyPenalty,
            presencePenalty: config.ai.presencePenalty,
          });
          if (!res.content) throw new Error('AI 返回内容为空');
          return res.content;
        },
        {
          retries: config.ai.maxRetries,
          label: `文章生成(${topic.title})`,
          // 重试预算 = 离截止时刻还剩多少。剩得不够就不再发起重试。
          budgetMs: Math.max(0, deadline - Date.now()),
        }
      );
    } catch (err) {
      logger.error(`文章生成失败: ${err.message}`);
      break;
    }

    const article = parseResponse(raw);
    if (!article) break;

    article.style = style;
    const report = article.humanReport || scoreHumanity(article.contentHtml);
    article.humanScore = report.score;

    if (!best || report.score > best.article.humanScore) best = { article, report };

    if (report.score >= minHumanScore) {
      logger.info(`人味自检通过：${report.score} 分（阈值 ${minHumanScore}）`);
      break;
    }
    if (attempt >= rewriteRounds) {
      // 这里必须报**最终返回的那一版**的分，而不是刚生成的这一版：
      // 重写可能反而更差，此时返回的是之前那版。报错了分，用户会拿着错误的数字
      // 去判断"要不要人工润色"，比不报还糟。
      const finalScore = best.article.humanScore;
      const kept = finalScore === report.score ? '最后一版' : `之前分数更高的一版（${finalScore} 分）`;
      logger.warn(
        `人味自检 ${finalScore} 分，低于阈值 ${minHumanScore}，已无重写轮次，保留${kept}。问题：${
          best.report.issues.join('；') || '无'
        }`
      );
      break;
    }

    logger.warn(`人味自检 ${report.score} 分 < ${minHumanScore}，带问题清单重写（第 ${attempt + 2} 版）`);
    feedback = buildRewriteInstruction(report);
  }

  if (best) {
    // 溯源检查。放在这里而不是发布前，是因为"要不要人工核对"的决策发生在生成完那一刻，
    // 而不是草稿箱里。它挡不住造假（文章也可能引用真实的公共事实），但能让编造**看得见**：
    // 在这之前，模型编的"起售价 12999 元"会一路静默地推进草稿箱，自检分还很高。
    const untraceable = flagUntraceableSpecifics(best.article.contentHtml, topic);
    best.article.untraceableSpecifics = untraceable;

    const total = untraceable.numbers.length + untraceable.quotes.length;
    if (total > 0) {
      const sample = [...untraceable.numbers, ...untraceable.quotes].slice(0, 6).join(' / ');
      logger.warn(
        `正文有 ${total} 处具体信息无法从话题输入溯源（${sample}${total > 6 ? ' …' : ''}）` +
          `——可能是公共事实，也可能是编造，发布前建议核对`
      );
    }
  }

  return best ? best.article : null;
}

/** 拼用户消息；feedback 非空时表示这是重写轮 */
function buildUserPrompt(topic, style, feedback) {
  const base = getPromptTemplate(topic, style);
  if (!feedback) return base;
  return `${base}\n\n${feedback}`;
}

/** 解析模型返回的 JSON，失败时走容错解析 */
function parseResponse(raw) {
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  const data = safeJsonParse(cleaned);
  if (data) {
    const missing = ['title', 'digest', 'contentHtml'].filter((f) => !data[f]);
    if (missing.length === 0) return postProcess(data);
    logger.warn(`AI响应缺少字段: ${missing.join(', ')}，尝试容错解析`);
  }

  // 容错路径**必须**同样过 postProcess。否则模型一吐出畸形 JSON，
  // 去AI味和段落打散就被整条跳过——文章照发，但反检测全白做，且不报任何错。
  // 温度调高、加了采样惩罚之后，畸形 JSON 的概率只会更高，这条路径不是罕见分支。
  const salvaged = fallbackParse(raw);
  return salvaged ? postProcess(salvaged) : null;
}

/** 从可能夹带解释文字的输出里抠出第一个完整 JSON 对象 */
function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * 文章后处理：去AI味 → 段落打散 → 体检打分 → 质量校验 → 注入尾部
 * 打分刻意放在注入尾部**之前**：尾部是固定模板（两段极短文案），会把段落节奏指标带偏。
 */
function postProcess(data) {
  const out = { ...data };

  out.contentHtml = String(out.contentHtml || '').trim();
  if (!out.contentHtml.startsWith('<')) {
    out.contentHtml = `<p style="${BODY_P_STYLE}">${out.contentHtml}</p>`;
  }

  if (config.articleStyle?.humanize !== false) {
    const body = humanizeContent(out.contentHtml);
    out.contentHtml = body.text;
    if (body.replacedCount > 0) logger.info(`去AI味处理：替换了 ${body.replacedCount} 类AI套话`);

    // 段落打散只在真的提分时才保留：切分本身也可能让节奏变差
    // （例如把本来就不错的段落切碎），所以用自检分兜底，只赚不赔。
    const restructured = restructureParagraphs(out.contentHtml);
    if (restructured !== out.contentHtml) {
      const beforeScore = scoreHumanity(out.contentHtml).score;
      const afterScore = scoreHumanity(restructured).score;
      if (afterScore >= beforeScore) {
        logger.info(`段落打散：人味分 ${beforeScore} → ${afterScore}`);
        out.contentHtml = restructured;
      }
    }
  }

  out.digest = humanizeContent(out.digest).text;

  const report = scoreHumanity(out.contentHtml);
  out.humanReport = report;
  out.humanScore = report.score;

  if (!out.contentHtml.includes('— END —')) {
    out.contentHtml = `${out.contentHtml}\n${ARTICLE_FOOTER}`;
  }

  if (out.title.length > 25) {
    logger.warn(`标题超长(${out.title.length}字)，已截断: ${out.title}`);
    out.title = out.title.slice(0, 25);
  }

  const charCount = out.contentHtml.replace(/<[^>]+>/g, '').replace(/\s/g, '').length;
  if (charCount < 800) logger.warn(`文章正文字数偏少(约${charCount}字)，质量可能不足`);
  else logger.info(`文章生成成功：${out.title}（约${charCount}字，人味分 ${report.score}）`);

  if (!Array.isArray(out.keywords)) out.keywords = [];

  return out;
}

/**
 * 容错解析：模型没有按要求输出 JSON 时，尽量把正文捞回来，
 * 而不是把整段原始输出（含 JSON 括号）当正文。
 */
function fallbackParse(raw) {
  const title = raw.match(/"title"\s*:\s*"([^"]+)"/)?.[1] || '热点文章';
  const digest = raw.match(/"digest"\s*:\s*"([^"]+)"/)?.[1] || '精彩内容等你来看';

  let contentHtml = raw.match(/"contentHtml"\s*:\s*"([\s\S]*?)"\s*,\s*"/)?.[1] || '';

  if (contentHtml) {
    // 还原 JSON 字符串里的转义
    contentHtml = contentHtml
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  } else {
    // 连字段都没有：先看模型有没有直接写出 <p> 段落，有就原样用
    const existing = raw.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi);
    if (existing?.length) {
      contentHtml = existing.join('');
    } else {
      // 退而求其次，把不像 JSON 结构的长句拼成正文。
      // 这里必须先把残留标签剥掉，否则会套出 <p><p>...</p></p> 这种嵌套段落。
      contentHtml = raw
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 20 && !/^[{}\[\]"]/.test(l))
        .slice(0, 10)
        .map((p) => `<p style="${BODY_P_STYLE}">${p.replace(/<[^>]+>/g, '')}</p>`)
        .join('');
    }
  }

  if (!contentHtml) {
    logger.error('容错解析未能提取到正文');
    return null;
  }

  return {
    title: title.slice(0, 25),
    digest,
    // 不在这里拼固定尾部：尾部注入统一由 postProcess 负责，避免两处都拼导致重复。
    contentHtml,
    keywords: [],
    imageQuery: 'news trending',
  };
}
