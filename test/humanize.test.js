/**
 * 人味自检与去AI味后处理的单元测试
 *
 * 打分阈值属于"经验值"，所以这里不去断言具体分数，只断言**相对关系**
 * （人写的样本必须显著高于 AI 味的样本），这样以后微调权重不会把测试调红。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMANITY_TARGETS,
  analyzeHumanity,
  buildRewriteInstruction,
  countStructuralRepetition,
  extractParagraphs,
  extractSpecifics,
  flagUntraceableSpecifics,
  humanizeContent,
  restructureParagraphs,
  scoreHumanity,
  splitSentences,
  stripHtml,
} from '../src/ai/humanize.js';

/** 有节奏、有细节、有口语的样本 —— 模拟真人写的公众号段落 */
const HUMAN_SAMPLE = `<p>说真的，我第一反应是"这也能上热搜？"。</p>
<p>点进去看了半小时，越看越不对劲。</p>
<p>事情的起点其实很小——上周三，杭州一个姑娘在小区群里发了张照片，说她家楼下那家开了十二年的面馆，突然贴了张纸，写着"本店转让"。就这么一张A4纸，被人拍下来发到网上，一天之内转了两万多条。</p>
<p>我翻评论区翻到凌晨，发现大家聊的根本不是面馆。有人在说小时候巷口那家馄饨摊，有人在说大学后门那个总多给一勺汤的老板娘。</p>
<p>扯远了，回到正题：为什么一家普通面馆关门，能让两万人集体破防？</p>
<p>我猜大概是因为——它太普通了。普通到我们每个人都有一家。</p>
<p>它关门的时候你甚至不在场，等你回去，那条街已经换成奶茶店了。</p>`;

/** 典型的 AI 八股：段长均匀、套话密集、没有任何具体细节 */
const AI_SAMPLE = `<p style="margin:16px 0;line-height:1.8;font-size:16px;color:#333;">在当今社会，餐饮行业的更新迭代速度日益加快，越来越多的传统小店面临着经营压力。近日，一则关于面馆转让的消息在网络上引发了广泛关注。</p>
<p style="margin:16px 0;line-height:1.8;font-size:16px;color:#333;">首先，从商业角度来看，小餐饮店的经营成本不断上升，租金、人力、原材料三方面的压力持续加大，这使得许多经营者不得不做出转让的决定。其次，从情感角度来看，这类小店往往承载着周边居民的生活记忆，因而容易引发共鸣。最后，从传播角度来看，社交媒体的快速扩散机制使得一则局部信息能够在短时间内触达大量用户。</p>
<p style="margin:16px 0;line-height:1.8;font-size:16px;color:#333;">值得注意的是，这一现象并非个例。综上所述，城市更新与个体记忆之间的张力，值得我们深入思考。总而言之，在时代发展的进程中，如何平衡效率与温度，是一个意义深远的课题。</p>`;

/** 统计某个标签的开闭是否配平 */
const tagBalance = (html, tag) => [
  (html.match(new RegExp(`<${tag}\\b`, 'gi')) || []).length,
  (html.match(new RegExp(`</${tag}>`, 'gi')) || []).length,
];

describe('stripHtml', () => {
  test('去掉标签并保留段落边界', () => {
    const text = stripHtml('<p style="a">第一段</p><p>第二段</p>');
    assert.ok(text.includes('第一段'));
    assert.ok(text.includes('第二段'));
    assert.ok(!text.includes('<'));
  });

  test('还原常见 HTML 实体', () => {
    assert.equal(stripHtml('<p>a&amp;b&nbsp;c</p>').includes('a&b'), true);
  });

  test('空输入不炸', () => {
    assert.equal(stripHtml(null), '');
    assert.equal(stripHtml(undefined), '');
  });
});

describe('splitSentences', () => {
  test('按中文句末标点切分', () => {
    const out = splitSentences('今天天气不错。你出门了吗？我不出去了！');
    assert.equal(out.length, 3);
    assert.equal(out[0], '今天天气不错。');
  });

  test('省略号算一个句末', () => {
    assert.equal(splitSentences('我想想……算了。').length, 2);
  });
});

describe('extractParagraphs', () => {
  test('HTML 按块级标签取，不把小标题算作段落', () => {
    const out = extractParagraphs('<h2>标题</h2><p>正文一</p><p>正文二</p>');
    assert.deepEqual(out, ['正文一', '正文二']);
  });

  test('纯文本按换行切', () => {
    assert.deepEqual(extractParagraphs('第一段\n\n第二段'), ['第一段', '第二段']);
  });
});

describe('scoreHumanity', () => {
  test('人写的样本显著高于 AI 味的样本', () => {
    const human = scoreHumanity(HUMAN_SAMPLE);
    const ai = scoreHumanity(AI_SAMPLE);
    assert.ok(
      human.score > ai.score + 30,
      `人味分应明显更高，实际 ${human.score} vs ${ai.score}`
    );
  });

  test('AI 八股样本拿到低分并列出问题', () => {
    const ai = scoreHumanity(AI_SAMPLE);
    assert.ok(ai.score < 40, `AI 样本不该及格，实际 ${ai.score}`);
    assert.ok(ai.issues.length >= 3, '应能列出多个问题');
  });

  test('AI 八股样本命中套话与句内排比', () => {
    const m = analyzeHumanity(AI_SAMPLE);
    assert.ok(m.aiPhraseHits > 5, `应命中多处套话，实际 ${m.aiPhraseHits}`);
    assert.ok(m.parallelFrames > 0, '"从…角度看"反复出现应被识别为排比框架');
  });

  test('人写的样本几乎没有套话，细节密度高', () => {
    const m = analyzeHumanity(HUMAN_SAMPLE);
    assert.equal(m.aiPhraseHits, 0);
    assert.ok(m.concreteDensity > HUMANITY_TARGETS.concreteDensity, `实际 ${m.concreteDensity}`);
    assert.ok(m.sentenceLenCV >= HUMANITY_TARGETS.sentenceLenCV, `句长波动不足：${m.sentenceLenCV}`);
  });

  test('分数落在 0-100 且带等级', () => {
    for (const sample of [HUMAN_SAMPLE, AI_SAMPLE, '', '<p>只有一句话。</p>']) {
      const r = scoreHumanity(sample);
      assert.ok(r.score >= 0 && r.score <= 100, `分数越界: ${r.score}`);
      assert.ok(['优', '良', '一般', '差'].includes(r.grade));
    }
  });
});

describe('countStructuralRepetition', () => {
  test('连续三句长度接近算一次排比', () => {
    const sentences = splitSentences('这是一个长度完全相同的句子。这也是一个长度完全相同的句子。这还是一个长度完全相同的句子。');
    assert.ok(countStructuralRepetition(sentences) >= 1);
  });

  test('长短交错的句子不算排比', () => {
    const sentences = splitSentences('短。这是一个稍微长一点点的句子，用来打破节奏。中等长度吧。');
    assert.equal(countStructuralRepetition(sentences), 0);
  });
});

describe('humanizeContent', () => {
  test('替换套话并返回替换类别数', () => {
    const { text, replacedCount } = humanizeContent('<p>综上所述，不得不说，这个方案值得我们关注。</p>');
    assert.ok(replacedCount >= 2);
    assert.ok(!text.includes('综上所述'));
    assert.ok(!text.includes('不得不说'));
  });

  test('干净文本不动，计数为 0', () => {
    const clean = '<p>我昨天去楼下买了杯咖啡，味道一般。</p>';
    const { text, replacedCount } = humanizeContent(clean);
    assert.equal(replacedCount, 0);
    assert.equal(text, clean);
  });

  test('空输入返回空串', () => {
    assert.equal(humanizeContent(null).text, '');
  });
});

describe('restructureParagraphs', () => {
  /** 生成一个足够长的、由短句拼成的段落 */
  const longParagraph = (times = 12) =>
    `<p style="margin:0;">${'这是一句用来测试切分的普通句子。'.repeat(times)}</p>`;

  test('把段落里的短句摘出来单独成段', () => {
    // 关键点：不是"把长段切成两半"，而是让中间那句短话独立成段
    const html =
      '<p>这是一段比较长的铺垫内容，用来说明前面的背景情况，读起来会比较长一些。' +
      '就这么简单。' +
      '后面还有一段继续展开的内容，用来把这个段落撑到足够的长度。</p>';

    const out = restructureParagraphs(html, { rng: () => 0 });
    const paragraphs = (out.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []).map((p) =>
      stripHtml(p).replace(/\s/g, '')
    );

    assert.ok(paragraphs.includes('就这么简单。'), `短句应独立成段，实际分段: ${JSON.stringify(paragraphs)}`);
  });

  test('短段落原样保留', () => {
    const html = '<p>就这么一句话，不该被切开。</p>';
    assert.equal(restructureParagraphs(html, { rng: () => 0 }), html);
  });

  test('长段落在句末被切开', () => {
    const html = longParagraph();
    const out = restructureParagraphs(html, { rng: () => 0 });
    assert.ok(out.split('<p').length > html.split('<p').length, '应被切成多段');
  });

  test('随机源说不切就不切（避免每个长段都按同一规则切，形成新规律）', () => {
    const html = longParagraph();
    assert.equal(restructureParagraphs(html, { rng: () => 0.99 }), html);
  });

  test('纯文本内容零丢失', () => {
    const html = longParagraph();
    const before = stripHtml(html).replace(/\s/g, '');
    const after = stripHtml(restructureParagraphs(html, { rng: () => 0 })).replace(/\s/g, '');
    assert.equal(after, before);
  });

  test('不会在行内标签内部切分，导致标签错配', () => {
    const html =
      `<p style="margin:0;">${'这是一句用来测试切分的普通句子。'.repeat(6)}` +
      `<strong style="color:#e04040;">这是重点内容，一定要完整保留下来。</strong>` +
      `${'这是后半段用来凑长度的普通句子。'.repeat(6)}</p>`;

    const out = restructureParagraphs(html, { rng: () => 0 });

    assert.deepEqual(tagBalance(out, 'strong'), [1, 1], 'strong 标签应保持配平');
    for (const chunk of out.match(/<p\b[^>]*>[\s\S]*?<\/p>/gi) || []) {
      const [open, close] = tagBalance(chunk, 'strong');
      assert.equal(open, close, `单段内 strong 标签未配平: ${chunk}`);
    }
    const before = stripHtml(html).replace(/\s/g, '');
    assert.equal(stripHtml(out).replace(/\s/g, ''), before, '内容不应丢失');
  });
});

describe('buildRewriteInstruction', () => {
  test('无问题时返回空串，不触发重写', () => {
    assert.equal(buildRewriteInstruction(null), '');
    assert.equal(buildRewriteInstruction({ issues: [] }), '');
  });

  test('有问题时给出可执行的重写要求', () => {
    const report = scoreHumanity(AI_SAMPLE);
    const text = buildRewriteInstruction(report);
    assert.ok(text.includes('句长剧烈波动'));
    assert.ok(text.includes('单句成段'));
    assert.ok(report.issues[0] && text.includes(report.issues[0]));
  });

  /*
   * 重写轮是主提示词之外**第二条**能影响正文的指令通道。
   * 这里原来写的是"至少 3 处具体到不能编造的细节"——只提要求、没提禁令，
   * 等于把 generator.js 里刚堵上的漏洞重新打开：模型为了达标会去编数字和原话。
   * 所以这两句必须钉住，删掉任何一句，重写轮就会重新变成"编造诱导器"。
   */
  test('重写要求里也必须带"不要编造"的禁令', () => {
    const text = buildRewriteInstruction(scoreHumanity(AI_SAMPLE));

    assert.ok(text.includes('绝不等于'), '重写要求应点明"具体"不等于"编造"');
    assert.ok(text.includes('凑不够 3 处就少写几处'), '应给模型留"凑不够就别凑"的出口');
    assert.ok(text.includes('禁止虚构引语'), '应点名禁止虚构引语安到真人头上');
  });

  test('"具体细节太少"这条问题描述本身要提醒别编数字', () => {
    // 这一项数的是数字/引语密度，不检查真假——不提醒的话，
    // 它就是在一句一句地指挥模型去编数字
    const report = scoreHumanity(AI_SAMPLE);
    const issue = report.issues.find((s) => s.includes('具体细节太少'));

    assert.ok(issue, 'AI 样本应命中"具体细节太少"');
    assert.ok(issue.includes('不要编造数字'), `实际：${issue}`);
  });
});

describe('打分可复现性', () => {
  // 段落打散带随机性。默认若用 Math.random，同一篇文章每次跑分都不一样
  // （实测 30 次抖动 7 分），打分器就没法当尺子用——同一个文件跑
  // `npm run score` 两次给出两个数，用户根本没法迭代。所以默认随机数必须由内容派生。

  test('同一输入重复打分，结果完全一致', () => {
    const runs = Array.from({ length: 12 }, () => scoreHumanity(restructureParagraphs(AI_SAMPLE)).score);
    assert.equal(new Set(runs).size, 1, `同一输入应得同一个分，实际出现 ${[...new Set(runs)].join(', ')}`);
  });

  test('内容变了，打散结果才跟着变', () => {
    const a = restructureParagraphs(AI_SAMPLE);
    const b = restructureParagraphs(`${AI_SAMPLE}<p>多出来的一段，用来改变内容哈希。</p>`);
    assert.notEqual(a, b);
  });

  test('显式传入 rng 时仍然尊重调用方', () => {
    const always = () => 0; // 0 <= splitChance → 每段都尝试切
    const never = () => 1; // 1 > splitChance → 一段都不切

    assert.equal(restructureParagraphs(AI_SAMPLE, { rng: never }), AI_SAMPLE, '不切分时应原样返回');

    const split = extractParagraphs(restructureParagraphs(AI_SAMPLE, { rng: always })).length;
    const kept = extractParagraphs(restructureParagraphs(AI_SAMPLE, { rng: never })).length;
    assert.ok(split > kept, `切分后段落数应更多：${split} vs ${kept}`);
  });
});

describe('flagUntraceableSpecifics', () => {
  // 背景：打分器的 concreteness 只数数字和引号，不查真假；而热搜接口又不给背景。
  // 实测模型编出过"8点07分""起售价12999元"，还把虚构引语安到真实博主头上，自检分却很高。
  // 这个检查不判定造假，只把"无法从输入溯源"的信息挑出来，缩小人工核对的范围。

  test('输入里有的数字不算可疑（含排名）', () => {
    const body = '<p>这个词条排到过第1位，热度显示为272.6万。</p>';
    const { numbers } = flagUntraceableSpecifics(body, {
      title: '某话题',
      summary: '【新】热度 272.6万',
      rank: 1,
    });
    assert.deepEqual(numbers, [], '1 和 272.6 都来自输入，不该被标出来');
  });

  test('输入里没有的数字会被标出来', () => {
    const body = '<p>上周三晚8点07分，视频全长12分47秒，起售价12999元。</p>';
    const { numbers } = flagUntraceableSpecifics(body, { title: '某话题', summary: '【新】热度 272.6万', rank: 1 });
    assert.ok(numbers.includes('8'), '8 点应被标出');
    assert.ok(numbers.includes('07'), '07 分应被标出');
    assert.ok(numbers.includes('12999'), '售价应被标出');
    assert.ok(!numbers.includes('272'), '输入里的数字不该被标出');
  });

  test('正文里的 HTML 标签（含内联样式）不会被当成数字', () => {
    // 微信公众号正文全是内联样式，font-size:16px、color:#333 这种数字极多，
    // 如果没剥干净，警告会被样式数字淹没，等于没有
    const body =
      '<p style="margin: 16px 0; line-height: 1.8; font-size: 16px; color: #333;">' +
      '只写了这么一句。</p>';
    const { numbers } = flagUntraceableSpecifics(body, { title: '某话题', summary: '', rank: 1 });
    assert.deepEqual(numbers, [], `样式里的数字应被剥离，实际：${numbers.join(', ')}`);
  });

  test('输入里没有的引语会被标出来，输入里有的不会', () => {
    const body = '<p>他置顶动态里写着"流程有争议我接受"，评论区有人回"这不就是行刑"。</p>';
    const { quotes } = flagUntraceableSpecifics(body, { title: '某话题', summary: '含"流程有争议我接受"一句' });
    assert.ok(
      quotes.some((q) => q.includes('这不就是行刑')),
      '输入里没有的引语应被标出'
    );
    assert.ok(
      !quotes.some((q) => q.includes('流程有争议我接受')),
      '输入里已有的引语不该被标出'
    );
  });

  test('话题为空时不报错，正文里的一切都算无法溯源', () => {
    const { numbers, quotes } = flagUntraceableSpecifics('<p>3 天前他说"再等等"。</p>', null);
    assert.deepEqual(numbers, ['3']);
    assert.equal(quotes.length, 1);
  });

  test('话题标题被加引号引用时，不算无法溯源', () => {
    // 实测误报（端到端跑批时出现的）：正文里写 “<话题标题>” 时，
    // 把"带引号的整体"拿去和输入比，当然比不到，于是标题自己被报成可疑项。
    // 要比的是引号里的**内容**在不在输入里。
    const body = `<p>大家都在聊\u201C何不同舟渡\u201D这件事。</p>`;
    const { quotes } = flagUntraceableSpecifics(body, { title: '何不同舟渡', summary: '热度 300万' });

    assert.deepEqual(quotes, [], `标题加引号不该被标出，实际：${quotes.join(' | ')}`);
  });

  test('编造的对话引语仍会被标出（不要为了消误报把真信号也去掉）', () => {
    const body = `<p>她回了句\u201C没事，我帮你\u201D就走了。</p>`;
    const { quotes } = flagUntraceableSpecifics(body, { title: '何不同舟渡', summary: '热度 300万' });

    assert.equal(quotes.length, 1, '编造的对话应被标出');
    assert.ok(quotes[0].includes('没事，我帮你'));
  });

  test('同一数字重复出现只报一次', () => {
    const { numbers } = flagUntraceableSpecifics('<p>4680 元，还是 4680 元。</p>', { title: 'x' });
    assert.deepEqual(numbers, ['4680']);
  });
});

describe('extractSpecifics', () => {
  // `npm run score` 用它把"具体细节"这一项数到的东西摊开给用户看。
  // 它只负责抽取，不判断真假。

  test('抽出数字串与引语，并去重', () => {
    const { numbers, quotes } = extractSpecifics(
      `<p>4680 元，还是 4680 元。他说\u201C算了\u201D，又说\u201C算了\u201D。</p>`
    );
    assert.deepEqual(numbers, ['4680']);
    assert.deepEqual(quotes, ['\u201C算了\u201D']);
  });

  test('HTML 标签与内联样式里的数字不会被抽出来', () => {
    const { numbers } = extractSpecifics('<p style="font-size:16px;color:#333">没有数字。</p>');
    assert.deepEqual(numbers, [], `实际：${numbers.join(', ')}`);
  });

  test('抽出的是全文，不做过不过输入源头的判断（那是 flagUntraceableSpecifics 的事）', () => {
    const all = extractSpecifics('<p>标题里就有的词 123。</p>');
    const untraceable = flagUntraceableSpecifics('<p>标题里就有的词 123。</p>', {
      title: '标题里就有的词 123',
    });
    assert.deepEqual(all.numbers, ['123'], 'extractSpecifics 不做溯源过滤');
    assert.deepEqual(untraceable.numbers, [], 'flagUntraceableSpecifics 才做过滤');
  });
});

describe('引号识别（曾经漏掉全角弯引号）', () => {
  /*
   * 回归测试。QUOTED_SPEECH 原本写成 /[""''「」『』]…/ ——在编辑器里看着像全角弯引号，
   * 实际存的是**半角 ASCII** 的 " 和 '（整行只有 「」『』 是非 ASCII）。
   * 后果：真实文章里的 “……” 一律匹配不上，concreteness 这一项等于瞎了，
   * 而中文文章绝大多数引号都用 “”。这个 bug 骗过了一轮完整的 A/B 分析。
   *
   * 下面每个引号形态都用 \u 转义写死——**故意不写字符**，
   * 因为就是"看着一样、实际不同"才出的错。
   */
  const FORMS = [
    ['全角双弯引号 U+201C/U+201D', '\u201C', '\u201D'],
    ['全角单弯引号 U+2018/U+2019', '\u2018', '\u2019'],
    ['直角双引号 U+300C/U+300D', '\u300C', '\u300D'],
    ['直角单引号 U+300E/U+300F', '\u300E', '\u300F'],
    ['半角双引号', '"', '"'],
    ['半角单引号', "'", "'"],
  ];

  for (const [label, open, close] of FORMS) {
    test(`${label} 里的原话能被识别`, () => {
      const { quotes } = flagUntraceableSpecifics(`他说${open}就是这样${close}。`, { title: '无关话题' });
      assert.equal(quotes.length, 1, `应识别出 1 处引语，实际 ${quotes.length}`);
      assert.ok(quotes[0].includes('就是这样'), `实际识别到：${quotes[0]}`);
    });
  }

  test('引语要计入 concreteness（修复前全角弯引号被整类漏掉）', () => {
    const withQuote = analyzeHumanity(`<p>他\u201C说了很多话\u201D，然后就走了。</p>`);
    const without = analyzeHumanity('<p>他说了很多话，然后就走了。</p>');

    assert.ok(
      withQuote.concreteHits > without.concreteHits,
      `带全角弯引号应多算具体细节：${withQuote.concreteHits} vs ${without.concreteHits}`
    );
  });

  test('全角弯引号也要计入"标点多样性"（同一类 bug 的第二处）', () => {
    // HUMAN_PUNCTUATION 里原本写的是半角 ASCII 的 "（还重复了两次），
    // 中文正文根本不会出现，于是用满引号的文章在这一项上一个引号都拿不到分。
    const withQuote = analyzeHumanity(`<p>他说\u201C好\u201D，然后就走了。</p>`);
    const without = analyzeHumanity('<p>他说好，然后就走了。</p>');

    assert.ok(
      withQuote.punctuationVariety > without.punctuationVariety,
      `用全角弯引号应多算 1 种标点：${withQuote.punctuationVariety} vs ${without.punctuationVariety}`
    );
  });

  test('标点多样性的目标值是可达到的（曾经有一种永远拿不到）', () => {
    // 这条是防"目标不可达"的回归：如果 HUMAN_PUNCTUATION 里又混进中文用不到的字符，
    // 标点齐全的样本就达不到目标值，所有文章都会在这一项上被无理由扣分。
    const rich = '<p>他说\u201C好\u201D——真的吗？当然！比如：这个、那个……（笑）</p>';
    const m = analyzeHumanity(rich);

    assert.ok(
      m.punctuationVariety >= HUMANITY_TARGETS.punctuationVariety,
      `标点齐全应达到 ${HUMANITY_TARGETS.punctuationVariety} 种，实际 ${m.punctuationVariety}：${m.punctuationTypes.join(' ')}`
    );
  });

  test('闭引号不能被当成开引号（否则会跨段配出一条垃圾引语）', () => {
    // 线上实录。修复前的正则把开引号和闭引号写在**同一个字符类**里：
    //   /[\u201C\u201D\u2018\u2019\u300C-\u300F"'][^…]{2,40}[\u201C\u201D\u2018\u2019\u300C-\u300F"']/g
    // 于是「手为什么非要“举”过头顶？」这一句：
    //   · `“举”` 内容只有 1 个字，达不到 {2,40} 的下限，**没匹配上**；
    //   · 紧接着的闭引号 `”` 就充当了开引号，一路配到 33 个字之后的另一个 `“`，
    //     中间还**跨了一个换行**。
    // 结果是既误报一条垃圾"引语"，又把它中间真正该被看见的内容吞掉。
    const text =
      '手为什么非要\u201C举\u201D过头顶？\n睡着以后的动作，而是身体在找一个\u201C舒服的姿势\u201D。';
    const { quotes } = extractSpecifics(text);

    assert.deepEqual(quotes, ['\u201C举\u201D', '\u201C舒服的姿势\u201D']);
    for (const q of quotes) {
      assert.ok(!q.includes('\n'), `引语不应跨段：${JSON.stringify(q)}`);
    }
  });

  test('孤立的闭引号不产生引语', () => {
    const { quotes } = extractSpecifics('这句话后面只有一个\u201D孤零零的闭引号。');
    assert.deepEqual(quotes, []);
  });

  test('引语不跨换行匹配', () => {
    const { quotes } = extractSpecifics('前半句\u201C开了引号\n后半句才\u201D闭上。');
    assert.deepEqual(quotes, []);
  });

  test('英文撇号不会被配成引语', () => {
    // 半角单引号要加"两侧不能是单词字符"的护栏，否则 `don't … it's`
    // 里两个撇号之间会被配成一条引语。
    const { quotes } = extractSpecifics("Don't worry, it's fine.");
    assert.deepEqual(quotes, []);
  });

  test('句读守卫必须用全角标点（半角不该被当成中文句读）', () => {
    // TONE_PARTICLE_PATTERN 的句尾语气词、PARALLEL_FRAMES 的"不跨句"守卫、
    // SENTENCE_END_CHARS 的切句，全都依赖**全角**的 ，。；？！。
    // 这些位置一旦被误写成半角（本会话同类错误已踩两次），守卫会静默失效。
    const full = analyzeHumanity('<p>算了吧。你说呢？走啊！</p>');
    const half = analyzeHumanity('<p>算了吧. 你说呢? 走啊!</p>');

    assert.ok(
      full.oralHits > half.oralHits,
      `全角标点后的语气词应被识别：${full.oralHits} vs ${half.oralHits}`
    );
    assert.ok(full.sentenceCount > half.sentenceCount, '全角句号应能切句');
  });
});
