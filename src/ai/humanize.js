/**
 * 人味化处理 & "AI 味"体检
 *
 * 为什么单独抽一个模块：腾讯朱雀这类 AIGC 检测器判定的是**统计特征**，不是字面用词。
 * 它主要看三个维度：
 *   1. 困惑度（perplexity）—— 用词有多容易被预测。AI 每步都挑概率最高的词，读起来"太顺"，
 *      而真人写作会有思维跳跃和不太常规的搭配。
 *   2. 结构规律性 —— AI 的段落过渡顺滑、段长均匀、句式工整；真人会忽长忽短、偶尔潦草。
 *   3. 词汇分布 —— 各家大模型有偏爱的连接词/套话，检测器统计它们的频次。
 *
 * 结论很反直觉但很重要：**把"首先"改成"第一个方面"、把"因此"换成"所以"基本没用**，
 * 因为底层语义模式没变，检测的是分布不是同义词。
 * 真正有效的是改变写作模式：句长剧烈波动、段落长短悬殊、塞具体细节、标点混用、
 * 允许口语重复和半截话。
 *
 * 所以本模块做两件事，分别对应"生成后"和"生成前"：
 *   - 生成后处理：humanizeContent（清套话）+ restructureParagraphs（打散段落节奏）
 *   - 自检打分：analyzeHumanity / scoreHumanity —— 把上面那些统计特征量化成 0-100 分，
 *     既用于自动触发"带反馈重写"，也用于 scripts/score.js 手工对着朱雀迭代。
 *
 * 打分是**代理指标**，不等于朱雀的真实输出；它的价值在于让优化有可比对的反馈，
 * 而不是每次都要人肉去检测平台点一遍。
 */

// ===== 去 AI 味词表 =====
// 只清理"一眼假"的高频套话。注意这不是主力手段（见文件头），
// 主力是生成阶段的句式控制，这里只做兜底清理。
export const AI_PHRASE_MAP = [
  // 总结套话
  [/综上所述[，,]?\s*/g, '说到这里，'],
  [/总而言之[，,]?\s*/g, '总的来说吧，'],
  [/一言以蔽之[，,]?\s*/g, '说白了，'],
  [/归根结底[，,]?\s*/g, '说到底，'],
  [/不得不说[，,]?\s*/g, '说真的，'],
  [/毋庸置疑[，,]?\s*/g, ''],
  [/不容置疑[，,]?\s*/g, ''],
  [/值得注意的是[，,]?\s*/g, '有一点要说一下，'],
  [/需要指出的是[，,]?\s*/g, '这里要说一下，'],
  [/不禁让人深思[。？]?\s*/g, '这事儿值得琢磨。'],
  [/令人深思[。，,]?\s*/g, '挺有意思的。'],
  [/不可忽视的是[，,]?\s*/g, ''],
  [/不可忽视[，,]?\s*/g, ''],
  [/不容小觑[。，,]?\s*/g, ''],
  [/由此可见[，,]?\s*/g, '所以嘛，'],
  [/正因如此[，,]?\s*/g, '也因为这个，'],
  [/深刻揭示了/g, '说明了'],
  [/无不体现/g, '都显示出'],
  [/彰显了?/g, '显出'],
  [/日益凸显/g, '越来越明显'],
  [/方兴未艾/g, '刚开始热起来'],
  [/举足轻重/g, '很关键'],
  // 开头套话
  [/在当今社会[，,]?\s*/g, '现在这个时候，'],
  [/随着时代的?发展[，,]?\s*/g, '现在嘛，'],
  [/随着[^，。]{2,12}的(?:不断|日益)[^，。]{0,6}[，,]/g, '这几年，'],
  [/在[^，。]{2,12}的大背景下[，,]?\s*/g, ''],
  [/众所周知[，,]?\s*/g, '大家都知道，'],
  [/不言而喻[，,]?\s*/g, '很明显，'],
  // 说教集体视角
  [/我们不难发现[，,]?\s*/g, '可以看出，'],
  [/我们可以看到[，,]?\s*/g, '能看出来，'],
  [/让我们一起\s*/g, ''],
  [/可以预见的是[，,]?\s*/g, '估计'],
  [/不难看出[，,]?\s*/g, '说白了，'],
  // AI 腔调词
  [/毫无疑问[，,]?\s*/g, '说真的，'],
  [/意义深远[。，,]?\s*/g, '影响不小。'],
  [/引人深思[。，,]?\s*/g, '值得想想。'],
  [/不禁感叹[，,]?\s*/g, '真的感慨，'],
  [/值得深思[。，,]?\s*/g, '挺值得想想的。'],
  [/发人深省[。，,]?\s*/g, '让人有点触动。'],
  [/从某种程度上(?:来说|说)?[，,]?\s*/g, ''],
  [/在一定程度上[，,]?\s*/g, ''],
  // 模板化连接词 —— 换成人话，但保留语义
  [/然而[，,]\s*/g, '不过，'],
  [/与此同时[，,]\s*/g, '同一时间，'],
  [/除此之外[，,]\s*/g, '另外，'],
  [/更重要的是[，,]\s*/g, '还有一点，'],
  [/换言之[，,]\s*/g, '说白了，'],
  [/首先[，,]\s*/g, '头一个，'],
  [/其次[，,]\s*/g, '再说，'],
  [/再次[，,]\s*/g, '还有，'],
  [/最后[，,]\s*/g, '还有一点，'],
];

// ===== 人味节奏目标值 =====
// 生成提示词里的硬指标和打分器的期望值共用这一份常量，避免两边漂移。
export const HUMANITY_TARGETS = {
  sentenceLenCV: 0.6, // 句长标准差 / 均值，越低说明节奏越平
  shortSentenceRatio: 0.18, // ≤10 字的短句占比
  longSentenceRatio: 0.1, // ≥45 字的长句占比
  paraLenCV: 0.6, // 段落长度变异系数
  singleSentenceParaRatio: 0.12, // 单句成段的比例
  aiPhraseDensity: 1, // 每千字 AI 套话命中数，越低越好
  concreteDensity: 5, // 每千字具体细节（数字/时间/金额/引语）数
  oralDensity: 4, // 每千字口语标记数
  punctuationVariety: 6, // 除逗号句号外出现的标点种类数
};

/** 句末标点（用于切句） */
const SENTENCE_END_CHARS = '。！？!?…';
/** 口语标记 */
const ORAL_PATTERN =
  /(我觉得|我感觉|我猜|我朋友|我同事|说真的|老实说|说实话|坦白讲|说白了|讲真|其实|反正|好歹|怎么说呢|你猜|话说回来|扯远了|对了|问题是|关键是|偏偏|结果呢|也就是说)/g;
/** 句尾语气词 */
const TONE_PARTICLE_PATTERN = /[啊嘛呢吧呗哈呀哦哎](?=[，。！？、])/g;
/**
 * 引号里的原话。
 * 评分（concreteHits）和"溯源检查"（flagUntraceableSpecifics）**共用这一个**——
 * 两处各写一份正则，迟早会改了一处忘了另一处。
 *
 * ⚠️ 引号一律用 \u 转义写，**不要直接敲字符**。
 * 这些引号在编辑器里长得几乎一样，肉眼分不出来。这里就踩过一次：
 * 源码里看着是“全角弯引号”，实际存的是半角 ASCII 的 " 和 '，
 * 于是真实文章里的 “……” 全部匹配不上——concreteness 这一项等于瞎了，
 * 而中文文章绝大多数引号都用 “”。用转义写，是唯一能防止再次写错的办法。
 *
 * 覆盖：全角弯引号 “”‘’(U+201C/201D/2018/2019)、直角引号 「」『』(U+300C-300F)、半角 " '
 */
/**
 * 引号内的内容。**开引号与闭引号必须是不同的字符集**，且内容里不许出现换行。
 *
 * 这里踩过两次坑，根因是同一个——把"成对"的东西写成了一个字符类：
 *  ① 最早用 ASCII 的 `"` 当引号，而中文正文用的是 `“”`，于是一个引号都认不出来；
 *  ② 改成 `[开闭混在一个类里]…[同一个类]` 之后，**闭引号会被当成开引号**。
 *     实测「手为什么非要“举”过头顶？」这一句：`“举”` 因为内容只有 1 个字
 *     （当时下限写成 ≥2）没匹配上，紧接着的闭引号 `”` 就充当了开引号，
 *     一路配到 33 个字之后的另一个 `“`——**跨了一整个段落**，
 *     产出一条纯属垃圾的"引语"，既误报，又把它中间真正该被看见的内容吞掉了。
 *
 * 所以这里显式成对（`“` 只能配 `”`），内容下限降到 1 个字（单字引用很常见），
 * 并排除换行（真实引语不跨段）。
 */
const QUOTED_SPEECH = new RegExp(
  [
    '\u201C[^\u201C\u201D\\n]{1,40}\u201D', // “……”
    '\u2018[^\u2018\u2019\\n]{1,40}\u2019', // ‘……’
    '\u300C[^\u300C\u300D\\n]{1,40}\u300D', // 「……」
    '\u300E[^\u300E\u300F\\n]{1,40}\u300F', // 『……』
    '"[^"\\n]{1,40}"', // "……"（半角，成对出现时）
    // 半角单引号。必须加"两侧不能是单词字符"的护栏，否则英文里的撇号会被配成引语：
    // `don't … it's` 会从第一个撇号一路配到第二个。中文引号不是它（中文用 ‘’，U+2018/2019），
    // 这里保留只是为了兼容混排英文的写法。
    "(?<!\\w)'[^'\\n]{1,40}'(?!\\w)",
  ].join('|'),
  'g'
);
/** 数字串。同样被评分与溯源检查共用 */
const NUMBER_RUN = /[0-9０-９]+/g;
/** 具体细节：数字 / 时间 / 金额 / 单位 / 引语 / 生活场景 */
const CONCRETE_PATTERNS = [
  NUMBER_RUN,
  /(?:去年|今年|昨天|前天|上周|上个月|前天|凌晨|半夜|周末|国庆|春节|开学|毕业)/g,
  QUOTED_SPEECH,
  /(?:我朋友|我同事|我妈|我女儿|我儿子|楼下|小区|地铁|公交|外卖|便利店|超市|食堂|办公室|工位|电梯)/g,
];
/**
 * 人味标点：AI 文本通常只有逗号句号顿号。
 *
 * ⚠️ 一律用 \u 转义写。这里原本写的是半角 ASCII 的 `"`（**还重复写了两次**），
 * 而中文正文里的引号是 `“”`——结果是：用了十几个引号的文章，
 * 在"标点多样性"上**一个引号都拿不到分**，而且 6 种的目标里有一种实际不可达。
 * 和 QUOTED_SPEECH 是同一类错误，别再直接敲字符。
 */
const HUMAN_PUNCTUATION = [
  '\u2014\u2014', // 破折号 ——
  '\u2026', // 省略号 …
  '\uFF1F', // 问号 ？
  '\uFF01', // 叹号 ！
  '\u201C', // 引号 “”（中文正文的引号就是它，不是半角 "）
  '\u300C', // 直角引号 「」
  '\uFF08', // 括号 （
  '\uFF1A', // 冒号 ：
  '\u3001', // 顿号 、
];
/** 结构性重复（排比 / 对仗 / 三段式）的句子开头 */
const STRUCTURE_MARKERS = /^(不是|而是|既|又|不仅|而且|一方面|另一方面|正如|就像|仿佛|无异于|与其|不如|无论|倘若|如果|因为|所以)/;
/**
 * 句内排比框架。
 * 只按句子切分抓不到"从商业角度看……从情感角度看……从传播角度看……"这种
 * 同一句话里塞三段排比的情况，得单独按短语框架统计。
 */
const PARALLEL_FRAMES = [
  /从[^，。；]{1,8}(?:角度|层面|维度|方面)/g,
  /在[^，。；]{1,10}层面(?:上)?/g,
  /[^，。；]{2,8}方面[，,]/g,
  /既[^，。；]{1,20}[，,]\s*又/g,
  /不是[^，。；]{1,25}[，,]\s*而是/g,
  /不仅[^，。；]{1,20}[，,]\s*(?:还|也|而且|更)/g,
  /一方面[\s\S]{2,80}?另一方面/g,
  /一[是则][^，。；]{1,20}[，,]\s*二[是则]/g,
  /(?:首|其)先[，,][\s\S]{2,150}?(?:其?次|然后)[，,]/g,
];

/** 去掉 HTML 标签，得到检测器真正会看到的纯文本 */
export function stripHtml(input) {
  return String(input ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|blockquote|li|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

/**
 * 按句末标点切句，返回去掉空白后的句子数组。
 *
 * 用「匹配」而不是「按位置切分」：`split(/(?<=[…]+)/)` 会把 `……` 从中间切开，
 * 一个省略号变成两个空句子。这里让连续的句末标点作为整体被消费掉。
 */
export function splitSentences(text) {
  const source = String(text ?? '');
  const out = [];
  // 每次匹配"若干非句末字符 + 一串连续句末标点"，从而把 `……`、`！！` 当成一个终止符
  const re = /[^。！？!?…]*(?:[。！？!?]+|…+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push(m[0]);
    last = re.lastIndex;
  }
  // 结尾没有句末标点的残句也要算上
  const tail = source.slice(last);
  if (tail.trim()) out.push(tail);

  return out.map((s) => s.replace(/\s+/g, '').trim()).filter((s) => s.length > 0);
}

/**
 * 取出段落（用于段落节奏统计）。
 * HTML 输入按块级标签取；纯文本输入按空行切。
 * 刻意不把 <h2> 算进来——小标题天然短，会把段落方差的基准带偏。
 */
export function extractParagraphs(input) {
  const source = String(input ?? '');
  const isHtml = /<\/?[a-z][^>]*>/i.test(source);

  if (!isHtml) {
    return source
      .split(/\n\s*\n|\n/)
      .map((p) => p.replace(/\s+/g, '').trim())
      .filter(Boolean);
  }

  const blocks = [];
  const re = /<(p|blockquote|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const text = stripHtml(m[2]).replace(/\s+/g, '').trim();
    if (text) blocks.push(text);
  }
  return blocks;
}

const mean = (nums) => (nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0);

const stddev = (nums) => {
  if (nums.length < 2) return 0;
  const mu = mean(nums);
  return Math.sqrt(mean(nums.map((n) => (n - mu) ** 2)));
};

const cv = (nums) => {
  const mu = mean(nums);
  return mu > 0 ? stddev(nums) / mu : 0;
};

const countMatches = (text, pattern) => (text.match(pattern) || []).length;

/** 统计连续同节奏句子的段数（≥3 句视为一次排比/对仗） */
export function countStructuralRepetition(sentences) {
  let hits = 0;
  let run = 1;
  for (let i = 1; i < sentences.length; i++) {
    const prev = sentences[i - 1];
    const cur = sentences[i];
    const sameOpener = prev.slice(0, 3) === cur.slice(0, 3);
    const sameTempo = prev.length >= 12 && cur.length >= 12 && Math.abs(prev.length - cur.length) <= 2;
    const sameMarker = STRUCTURE_MARKERS.test(prev) && STRUCTURE_MARKERS.test(cur);
    if (sameOpener || sameTempo || sameMarker) {
      run++;
    } else {
      if (run >= 3) hits++;
      run = 1;
    }
  }
  if (run >= 3) hits++;
  return hits;
}

/**
 * 体检：把一段文本（HTML 或纯文本）拆成可比较的统计指标
 * @param {string} input
 * @returns {object} metrics
 */
export function analyzeHumanity(input) {
  const text = stripHtml(input).replace(/\s+/g, '');
  const sentences = splitSentences(text);
  const paragraphs = extractParagraphs(input);

  const sentenceLens = sentences.map((s) => s.length);
  const paraLens = paragraphs.map((p) => p.length);
  const charCount = Math.max(1, text.length);

  const per1000 = (n) => Number(((n / charCount) * 1000).toFixed(2));

  const aiPhraseHits = AI_PHRASE_MAP.reduce((sum, [pattern]) => {
    // 词表里的正则带 g 标志，match 不会共享 lastIndex，可安全复用
    return sum + countMatches(text, pattern);
  }, 0);

  const concreteHits = CONCRETE_PATTERNS.reduce((sum, p) => sum + countMatches(text, p), 0);
  // 一个框架只出现 1 次不算排比，所以按"框架重复 ≥2 次"计数
  const parallelFrames = PARALLEL_FRAMES.filter((p) => countMatches(text, p) >= 2).length;
  const oralHits = countMatches(text, ORAL_PATTERN) + countMatches(text, TONE_PARTICLE_PATTERN);
  const punctuationTypes = HUMAN_PUNCTUATION.filter((p) => text.includes(p));

  return {
    charCount,
    sentenceCount: sentences.length,
    avgSentenceLen: Number(mean(sentenceLens).toFixed(1)),
    sentenceLenCV: Number(cv(sentenceLens).toFixed(3)),
    shortSentenceRatio: Number((sentenceLens.filter((n) => n <= 10).length / Math.max(1, sentences.length)).toFixed(3)),
    longSentenceRatio: Number((sentenceLens.filter((n) => n >= 45).length / Math.max(1, sentences.length)).toFixed(3)),
    paragraphCount: paragraphs.length,
    paraLenCV: Number(cv(paraLens).toFixed(3)),
    paraMinLen: paraLens.length ? Math.min(...paraLens) : 0,
    paraMaxLen: paraLens.length ? Math.max(...paraLens) : 0,
    singleSentenceParaRatio: Number(
      (paragraphs.filter((p) => splitSentences(p).length <= 1).length / Math.max(1, paragraphs.length)).toFixed(3)
    ),
    aiPhraseHits,
    aiPhraseDensity: per1000(aiPhraseHits),
    concreteHits,
    concreteDensity: per1000(concreteHits),
    oralHits,
    oralDensity: per1000(oralHits),
    punctuationTypes,
    punctuationVariety: punctuationTypes.length,
    structuralRepetition: countStructuralRepetition(sentences),
    parallelFrames,
  };
}

/**
 * 线性映射到 0-100。
 * bad/good 谁大谁小都可以：bad > good 表示"越小越好"。
 */
function ramp(value, bad, good) {
  if (bad === good) return value === good ? 100 : 0;
  const t = (value - bad) / (good - bad);
  return Math.round(Math.max(0, Math.min(1, t)) * 100);
}

/** 各维度权重，合计 1.0 */
const WEIGHTS = {
  burstiness: 0.22,
  shortSentences: 0.1,
  longSentences: 0.08,
  paragraphRhythm: 0.15,
  singleSentencePara: 0.08,
  phraseFree: 0.15,
  concreteness: 0.1,
  oral: 0.07,
  punctuation: 0.05,
};

/**
 * 打分：0-100，越高越像人写的。
 * @param {string} input HTML 或纯文本
 * @returns {{score:number, grade:string, metrics:object, breakdown:object, issues:string[]}}
 */
export function scoreHumanity(input) {
  const m = analyzeHumanity(input);
  const t = HUMANITY_TARGETS;

  const breakdown = {
    burstiness: ramp(m.sentenceLenCV, 0.25, t.sentenceLenCV + 0.15),
    shortSentences: ramp(m.shortSentenceRatio, 0.03, t.shortSentenceRatio + 0.05),
    longSentences: ramp(m.longSentenceRatio, 0.02, t.longSentenceRatio + 0.05),
    paragraphRhythm: ramp(m.paraLenCV, 0.25, t.paraLenCV + 0.15),
    singleSentencePara: ramp(m.singleSentenceParaRatio, 0, t.singleSentenceParaRatio + 0.06),
    phraseFree: ramp(m.aiPhraseDensity, 6, 0),
    concreteness: ramp(m.concreteDensity, 1.5, t.concreteDensity + 2),
    oral: ramp(m.oralDensity, 0.5, t.oralDensity + 1),
    punctuation: ramp(m.punctuationVariety, 2, t.punctuationVariety),
  };

  let score = Object.entries(WEIGHTS).reduce((sum, [key, w]) => sum + breakdown[key] * w, 0);
  // 排比/对仗是强信号，直接扣分
  score -= Math.min(15, m.structuralRepetition * 5 + m.parallelFrames * 4);
  score = Math.round(Math.max(0, Math.min(100, score)));

  const grade = score >= 80 ? '优' : score >= 65 ? '良' : score >= 50 ? '一般' : '差';

  return { score, grade, metrics: m, breakdown, issues: collectIssues(m, breakdown) };
}

/** 找出拖后腿的维度，转成人能看懂的问题描述 */
function collectIssues(m, breakdown) {
  const issues = [];
  const weak = Object.entries(breakdown)
    .filter(([, v]) => v < 60)
    .sort((a, b) => a[1] - b[1]);

  const describe = {
    burstiness: `句子长度太均匀（变异系数 ${m.sentenceLenCV}，目标 ≥${HUMANITY_TARGETS.sentenceLenCV}），读起来像匀速朗读`,
    shortSentences: `几乎没有短句（≤10 字的句子只占 ${(m.shortSentenceRatio * 100).toFixed(1)}%），缺少停顿感`,
    longSentences: `缺少长句（≥45 字的句子只占 ${(m.longSentenceRatio * 100).toFixed(1)}%），节奏偏碎`,
    paragraphRhythm: `段落长度太接近（变异系数 ${m.paraLenCV}），需要有的段只有一两句、有的段很长`,
    singleSentencePara: `没有单句成段（当前 ${(m.singleSentenceParaRatio * 100).toFixed(1)}%），缺少视觉呼吸感`,
    phraseFree: `AI 套话密度偏高（每千字 ${m.aiPhraseDensity} 处），命中了 ${m.aiPhraseHits} 处`,
    // 这一项数的是"数字 / 时间 / 引语"的密度，**不检查真假**。
    // 所以提示语里必须带一句"别为了补这一项去编"——否则它就是在指挥模型编数字。
    concreteness: `具体细节太少（每千字 ${m.concreteDensity} 个数字/时间/引语），显得空泛——补充时请用确实知道的事实或具体场景，不要编造数字`,
    oral: `口语标记偏少（每千字 ${m.oralDensity} 个），人称和语气不够`,
    punctuation: `标点太单调（只用到 ${m.punctuationVariety} 种），缺少破折号/省略号/问号/引号`,
  };

  for (const [key] of weak) {
    if (describe[key]) issues.push(describe[key]);
  }
  if (m.structuralRepetition > 0) {
    issues.push(`检测到 ${m.structuralRepetition} 处连续同节奏句子（排比/对仗），这是最典型的 AI 特征`);
  }
  if (m.parallelFrames > 0) {
    issues.push(`检测到 ${m.parallelFrames} 类反复出现的排比框架（如"从……角度看""一方面……另一方面"）`);
  }
  return issues;
}

/**
 * 把体检报告转成给模型的改写指令，用于"带反馈重写"。
 * 只讲要改什么、改成什么样，不复述原文，避免模型照抄一遍。
 */
/**
 * 抽出正文里被算作"具体信息"的东西：数字串 + 引号内的原话。
 * 就是 `concreteness` 那一项统计的对象。`npm run score` 会把它列出来，
 * 让用户看清"这个分数是由哪些数字和引语挣来的"。
 *
 * ⚠️ 只抽出来，**不判断真假**——真假要靠人工核对，或者用下面的溯源检查缩小范围。
 */
export function extractSpecifics(input) {
  const text = stripHtml(input);
  const uniq = (arr) => [...new Set(arr)];
  return {
    numbers: uniq(text.match(NUMBER_RUN) || []),
    quotes: uniq(text.match(QUOTED_SPEECH) || []),
  };
}

/**
 * 找出正文里**无法从话题输入溯源**的具体信息（数字串 / 引号里的原话）。
 *
 * 为什么需要它：`concreteness` 只数数字和引号出现了几次，**不检查真假**，
 * 而热搜接口又不提供任何背景。实测出现过模型编造"8点07分""起售价12999元"
 * 并把虚构引语安到真实博主头上的情况，而自检分照样很高（87）。
 * 这个检查让那些编造**看得见**，而不是一路静默地推进草稿箱。
 *
 * 注意这是**提示人工核对**，不是判定造假：文章完全可能引用真实的公共事实
 * （某个历史事件、某个已知产品的售价），那些也会出现在这个列表里。
 * 它的价值在于把"要不要核对"这件事从"你得读完整篇"缩小到"看这几个词"。
 *
 * @param {string} input 文章正文（HTML 或纯文本；HTML 标签内的样式数字会被剥离）
 * @param {{title?:string, summary?:string, rank?:number}} topic 话题输入
 * @returns {{numbers:string[], quotes:string[]}}
 */
export function flagUntraceableSpecifics(input, topic) {
  // rank 也要算进去：提示词的"来源"行里本来就有"热度排名第 N 位"，
  // 正文引用这个数字是合理的，不该被当成可疑项
  const source = `${topic?.title ?? ''} ${topic?.summary ?? ''} ${topic?.rank ?? ''}`;
  const sourceNumbers = new Set(source.match(NUMBER_RUN) || []);
  const { numbers, quotes } = extractSpecifics(input);

  return {
    numbers: numbers.filter((n) => !sourceNumbers.has(n)),
    // 引号要看**内容**在不在输入里，而不是把"带引号的整体"拿去比。
    // 实测踩过：正文里出现 “<话题标题>” 时，带引号的形式当然不在输入里，
    // 于是标题自己被报成"无法溯源"，属于最显眼的一种误报。
    quotes: quotes.filter((q) => !source.includes(q.slice(1, -1))),
  };
}

export function buildRewriteInstruction(report) {
  if (!report?.issues?.length) return '';
  return [
    '你上一版被判定"AI 味过重"，自动体检结果如下（检测器看的是统计分布，不是同义词）：',
    ...report.issues.map((s, i) => `${i + 1}. ${s}`),
    '',
    '请重写全文，重点修正以上问题，并且必须满足：',
    `- 句长剧烈波动：既有 6-8 字的短句，也有 45 字以上的长句，句长变异系数 ≥ ${HUMANITY_TARGETS.sentenceLenCV}`,
    `- 至少 ${Math.max(2, Math.round(report.metrics.paragraphCount * HUMANITY_TARGETS.singleSentenceParaRatio))} 个"单句成段"`,
    `- 最短段 ≤35 字、最长段 ≥180 字，段落长短要拉开`,
    // 这一条必须和 generator.js 里的第 4 条保持同一口径。
    // 曾经这里写的是"至少 3 处具体到不能编造的细节"——只提要求、没提禁令，
    // 结果重写轮会把主提示词刚堵上的漏洞重新打开：模型为了达标去编数字和原话。
    '- 至少 3 处具体的细节（具体日期、金额、地名、品牌型号、某个人说的话）。',
    '  但"具体"绝不等于"编造"：不确定的数字 / 时间 / 价格 / 当事人原话一律不要写，',
    '  凑不够 3 处就少写几处，尤其禁止虚构引语再安到真实存在的人或机构头上。',
    '- 至少 1 处自我修正（"……不对，准确说是……"）和 1 处跑题再拉回（"扯远了，回到正题"）',
    '- 标点至少混用破折号、省略号、问号、引号中的三种',
    '- 删掉所有排比、对仗、三段式结构，不要让连续三句话节奏一样',
    '- 保留原有事实与观点，不要改变结论',
  ].join('\n');
}

// ===== 生成后处理 =====

/**
 * 词汇层：把 AI 套话替换成口语表达
 * @param {string} input
 * @returns {string}
 */
export function humanizeContent(input) {
  let result = String(input ?? '');
  let replacedCount = 0;
  for (const [pattern, replacement] of AI_PHRASE_MAP) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) replacedCount++;
  }
  return { text: result, replacedCount };
}

/** 自闭合/空元素标签，不参与嵌套深度计算 */
const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'source', 'meta', 'link']);
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;

/**
 * 找出段落里可以安全切分的位置。
 *
 * 关键是**只在嵌套深度为 0 的地方切**。否则遇到
 * `<p><strong>甲。乙。</strong></p>` 会切成
 * `<p><strong>甲。</p><p>乙。</strong></p>` —— 标签直接错配，微信里排版会崩。
 */
function safeSplitPoints(inner) {
  const points = [];
  const stack = [];

  const scanText = (text, offset) => {
    if (stack.length > 0) return; // 在行内标签内部，不能切
    let idx = 0;
    for (const ch of text) {
      if (SENTENCE_END_CHARS.includes(ch)) {
        const abs = offset + idx + 1;
        // 切点落在最末尾会切出一个空段，没意义
        if (abs < inner.length - 1) points.push(abs);
      }
      idx += ch.length;
    }
  };

  let cursor = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(inner)) !== null) {
    scanText(inner.slice(cursor, m.index), cursor);

    const [full, name, selfClosing] = m;
    const tag = name.toLowerCase();
    if (full.startsWith('</')) {
      // 用 lastIndexOf 而不是 pop：遇到残缺标签时能自愈，不至于整体错位
      const pos = stack.lastIndexOf(tag);
      if (pos !== -1) stack.splice(pos);
    } else if (!selfClosing && !VOID_TAGS.has(tag)) {
      stack.push(tag);
    }
    cursor = TAG_RE.lastIndex;
  }
  scanText(inner.slice(cursor), cursor);

  return points;
}

/**
 * 结构层：打散段落节奏，制造"段落长短悬殊 + 单句成段"。
 *
 * 思路不是简单地"把长段切成两半"——那样切出来的还是两段中等长度的段落，指标几乎不动。
 * 真正有用的是**把段落里那句短话单独摘出来成段**：它是"单句成段"和"短段落"两个指标的
 * 主要来源，而且读起来最像人在换气。
 *
 * 刻意带随机性（rng）：如果每个段落都按同一规则切，本身又会变成一种新规律，
 * 检测器照样能看出来。所以只对一部分段落动手，且切点不固定。
 *
 * @param {string} html
 * @param {object} [options]
 * @param {() => number} [options.rng] 随机源，测试可注入固定序列
 * @param {number} [options.minParaLen=50] 短于此长度的段落不动
 * @param {number} [options.shortSentenceMax=28] 多短算"可以独立成段的短句"
 * @param {number} [options.splitChance=0.7] 合格段落被处理的概率
 * @returns {string}
 */
/**
 * 把字符串折成一个 32 位种子（FNV-1a）。
 * 用途：让"同样的输入"派生出"同样的随机数序列"。
 */
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** mulberry32：短小、分布够用的确定性伪随机数发生器 */
function makeSeededRng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function restructureParagraphs(html, options = {}) {
  const source = String(html ?? '');
  // 默认随机数**由内容派生**，而不是 Math.random。
  // 原因：打散带随机性，用真随机会让同一篇文章每次跑分都不一样（实测抖动 7 分），
  // 打分器就没法当尺子用了——同一个文件跑 `npm run score` 两次给出两个数，无法迭代。
  // 改成内容派生后：同输入必得同分，改一个字才会变。
  const rng = options.rng || makeSeededRng(hashSeed(source));
  const { minParaLen = 50, shortSentenceMax = 28, splitChance = 0.7 } = options;
  if (!source) return source;

  return source.replace(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi, (whole, attrs, inner) => {
    const plain = stripHtml(inner).replace(/\s+/g, '');
    if (plain.length < minParaLen) return whole;
    if (rng() > splitChance) return whole;

    const points = safeSplitPoints(inner);
    if (!points.length) return whole;

    const prefixLen = (p) => stripHtml(inner.slice(0, p)).replace(/\s+/g, '').length;
    const cuts = [];

    // 目标一：找一句短句，在它**前后各切一刀**，让它单独成段。
    // points[i] 是第 i+1 句的结束位置，所以 points[i-1] 正好是这句的起点。
    const shortIdx = points.findIndex(
      (p, i) => prefixLen(p) - (i > 0 ? prefixLen(points[i - 1]) : 0) <= shortSentenceMax
    );
    if (shortIdx === 0) {
      cuts.push(points[0]); // 首句就短，直接切出来当开头
    } else if (shortIdx > 0) {
      cuts.push(points[shortIdx - 1], points[shortIdx]);
    }

    // 目标二：段落本身仍然过长，再补一刀，避免留下几百字的巨无霸段落
    if (plain.length >= 150) {
      const mid = points.find((p) => {
        const len = prefixLen(p);
        return len >= plain.length * 0.5 && len <= plain.length * 0.75 && !cuts.includes(p);
      });
      if (mid) cuts.push(mid);
    }

    if (!cuts.length) return whole;

    const chunks = [];
    let cursor = 0;
    for (const cut of cuts.sort((a, b) => a - b)) {
      if (cut <= cursor) continue;
      chunks.push(inner.slice(cursor, cut));
      cursor = cut;
    }
    chunks.push(inner.slice(cursor));

    return chunks
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => `<p${attrs}>${c}</p>`)
      .join('');
  });
}
