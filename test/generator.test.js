/**
 * 文章生成链路测试
 *
 * 不打真实模型接口：把 config.ai.doubaoBaseUrl 指向本地 mock（豆包是 OpenAI 兼容协议，
 * 用它做替身最省事），然后断言"发出去的请求长什么样"和"拿回来的文章被怎么处理了"。
 *
 * 重点覆盖 v2.2 的反 AI 检测改动：
 *   - 生成后必须做去AI味替换 + 段落打散
 *   - 必须算出人味分
 *   - 分数不达标时要带着问题清单重写一轮，并且最终返回的是**分更高的那一版**
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import config from '../config/index.js';
import { HUMANITY_TARGETS, humanizeContent, scoreHumanity } from '../src/ai/humanize.js';

/** 节奏好、有细节的"人味"正文 */
const GOOD_BODY =
  '<p>说真的，我第一反应是"这也行？"。</p>' +
  '<p>点进去看了半小时，越看越不对劲。</p>' +
  '<p>起点其实很小——上周三，杭州一个姑娘在小区群里发了张照片，说楼下那家开了十二年的面馆贴了张纸，写着"本店转让"。就这么一张A4纸，一天之内转了两万多条。</p>' +
  '<p>扯远了，回到正题：为什么一家普通面馆关门，能让两万人集体破防？</p>' +
  '<p>我猜大概是因为——它太普通了。</p>';

/** 典型 AI 八股正文，人味分很低，用来触发重写 */
const BAD_BODY =
  '<p>在当今社会，餐饮行业的更新迭代速度日益加快，越来越多的传统小店面临着经营压力。</p>' +
  '<p>首先，从商业角度来看，经营成本不断上升，租金、人力、原材料三方面的压力持续加大，这使得许多经营者不得不做出转让的决定。其次，从情感角度来看，这类小店往往承载着周边居民的生活记忆，因而容易引发共鸣。最后，从传播角度来看，社交媒体的快速扩散机制使得一则局部信息能够在短时间内触达大量用户。</p>' +
  '<p>值得注意的是，这一现象并非个例。综上所述，城市更新与个体记忆之间的张力值得我们深入思考。总而言之，如何平衡效率与温度是一个意义深远的课题。</p>';

/**
 * 比 BAD_BODY 更差的一版：套话更密、句子等长、还带排比。
 * 实测稳定在 44 分，而 BAD_BODY 稳定在 64 分——两者区间不重叠，
 * 所以"重写反而更差"这个场景可以被确定性地复现（打分器已改成内容派生的确定性随机数）。
 */
const WORSE_BODY =
  '<p>在当今社会，随着时代的发展，这一现象无疑具有深远的意义，值得我们深入思考。</p>' +
  '<p>首先，从商业角度来看，这一趋势日益凸显，彰显了时代特征，值得我们深入思考。</p>' +
  '<p>其次，从情感角度来看，这一趋势日益凸显，彰显了时代特征，值得我们深入思考。</p>' +
  '<p>再次，从传播角度来看，这一趋势日益凸显，彰显了时代特征，值得我们深入思考。</p>' +
  '<p>综上所述，毫无疑问，这一现象意义深远，发人深省，令人深思。</p>';

const state = {
  /** 依次返回的正文，用完后复用最后一个 */
  queue: [],
  /** 收到的请求体 */
  requests: [],
  /** 置 true 时直接把 queue 里的字符串当模型原始输出返回（用于测试容错解析） */
  rawMode: false,
  /** 响应的 finish_reason；置 'length' 模拟被 max_tokens 截断 */
  finishReason: 'stop',
};

function startMockServer() {
  const server = http.createServer((req, res) => {
    // 环境有 HTTP_PROXY 时 req.url 可能是绝对形式，必须用 URL 解析
    const pathname = new URL(req.url, 'http://localhost').pathname;

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (pathname !== '/chat/completions') {
        res.writeHead(404).end('not found');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      state.requests.push(body);

      const bodyHtml = state.queue.length > 1 ? state.queue.shift() : state.queue[0] || '<p>默认正文。</p>';
      const content = state.rawMode
        ? bodyHtml
        : JSON.stringify({
            title: '这是一条测试标题',
            digest: '这是一段测试摘要，用于验证解析流程是否正常工作。',
            contentHtml: bodyHtml,
            keywords: ['测试'],
            imageQuery: 'test scene',
          });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: state.finishReason, message: { role: 'assistant', content } }],
        })
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

let mock;
let saved;
let generateArticle;

before(async () => {
  // 预热懒加载依赖：沙箱里首次 import 很慢，会把本地连接拖到被重置
  await import('axios');
  const mod = await import('../src/ai/generator.js');
  generateArticle = mod.generateArticle;

  mock = await startMockServer();

  saved = {
    provider: config.ai.provider,
    doubaoKey: config.ai.doubaoKey,
    doubaoBaseUrl: config.ai.doubaoBaseUrl,
    maxRetries: config.ai.maxRetries,
    frequencyPenalty: config.ai.frequencyPenalty,
    presencePenalty: config.ai.presencePenalty,
    style: config.articleStyle.style,
    temperature: config.articleStyle.temperature,
    humanize: config.articleStyle.humanize,
    minHumanScore: config.articleStyle.minHumanScore,
    rewriteRounds: config.articleStyle.rewriteRounds,
    totalBudgetMs: config.articleStyle.totalBudgetMs,
  };

  config.ai.provider = 'doubao';
  config.ai.doubaoKey = 'test-key';
  config.ai.doubaoBaseUrl = mock.base;
  config.ai.maxRetries = 0; // 失败就别退避重试了，测试要快
});

after(async () => {
  Object.assign(config.ai, {
    provider: saved.provider,
    doubaoKey: saved.doubaoKey,
    doubaoBaseUrl: saved.doubaoBaseUrl,
    maxRetries: saved.maxRetries,
    frequencyPenalty: saved.frequencyPenalty,
    presencePenalty: saved.presencePenalty,
  });
  Object.assign(config.articleStyle, {
    style: saved.style,
    temperature: saved.temperature,
    humanize: saved.humanize,
    minHumanScore: saved.minHumanScore,
    rewriteRounds: saved.rewriteRounds,
    totalBudgetMs: saved.totalBudgetMs,
  });
  await new Promise((r) => mock.server.close(r));
});

beforeEach(() => {
  state.queue = [];
  state.requests = [];
  state.rawMode = false;
  state.finishReason = 'stop';
  config.ai.maxRetries = 0;
  config.articleStyle.humanize = true;
  config.articleStyle.rewriteRounds = 0;
  config.articleStyle.minHumanScore = 70;
  config.articleStyle.temperature = 0.9;
  config.articleStyle.totalBudgetMs = 600_000;
});

const TOPIC = { id: 't1', title: '测试话题', summary: '测试背景', source: 'weibo', rank: 1 };

test('正常生成：解析 JSON、注入尾部、算出人味分', async () => {
  state.queue = [GOOD_BODY];
  const article = await generateArticle(TOPIC);

  assert.ok(article, '应生成成功');
  assert.equal(article.title, '这是一条测试标题');
  assert.ok(article.contentHtml.includes('— END —'), '应注入固定尾部');
  assert.equal(typeof article.humanScore, 'number');
  assert.ok(article.humanScore >= 0 && article.humanScore <= 100);
  assert.equal(article.style, 'default');
});

test('去AI味后处理生效：套话被替换掉', async () => {
  state.queue = ['<p>综上所述，在当今社会，这个话题不得不说值得关注。</p>'];
  const article = await generateArticle(TOPIC);

  assert.ok(!article.contentHtml.includes('综上所述'));
  assert.ok(!article.contentHtml.includes('在当今社会'));
  assert.ok(!article.contentHtml.includes('不得不说'));
});

test('humanize 关闭时正文原样保留', async () => {
  config.articleStyle.humanize = false;
  state.queue = ['<p>综上所述，这个话题值得关注。</p>'];
  const article = await generateArticle(TOPIC);

  assert.ok(article.contentHtml.includes('综上所述'));
});

test('单篇预算用尽时不再开重写轮次（对照组：预算充足会重写）', async () => {
  config.articleStyle.rewriteRounds = 1;
  config.articleStyle.minHumanScore = 100; // 第 0 轮必然"不达标"，正常情况下会触发重写
  state.queue = [BAD_BODY, BAD_BODY];

  // 对照组：预算充足 → 应当重写，共 2 次模型调用。
  // 有这一组，下面的断言才有意义：否则"只调用 1 次"可能只是因为压根没触发重写。
  config.articleStyle.totalBudgetMs = 600_000;
  await generateArticle(TOPIC);
  const withBudget = state.requests.length;

  // 实验组：预算为 0 → 第 1 轮开始前就被拦下，只打 1 次
  state.requests = [];
  config.articleStyle.totalBudgetMs = 0;
  const article = await generateArticle(TOPIC);
  const withoutBudget = state.requests.length;

  assert.equal(withBudget, 2, '预算充足时应当重写一轮');
  assert.equal(withoutBudget, 1, '预算用尽后不应再发起重写');
  assert.ok(article, '预算用尽也应交出已有版本，而不是返回 null');
  assert.equal(typeof article.humanScore, 'number');
});

test('采样参数随请求发出（温度 / 惩罚项）', async () => {
  config.articleStyle.temperature = 0.95;
  state.queue = [GOOD_BODY];
  await generateArticle(TOPIC);

  const sent = state.requests[0];
  assert.equal(sent.temperature, 0.95);
  assert.equal(sent.frequency_penalty, config.ai.frequencyPenalty);
  assert.equal(sent.presence_penalty, config.ai.presencePenalty);
  assert.equal(sent.model, config.ai.doubaoModel);
});

test('人味分不达标时带问题清单重写，并返回分更高的那一版', async () => {
  config.articleStyle.rewriteRounds = 1;
  state.queue = [BAD_BODY, GOOD_BODY];

  const article = await generateArticle(TOPIC);

  assert.equal(state.requests.length, 2, '应发出两次生成请求');

  const feedback = state.requests[1].messages.at(-1).content;
  assert.ok(feedback.includes('句长剧烈波动'), '第二次请求应带上重写要求');
  assert.ok(feedback.includes('AI 套话密度偏高') || feedback.includes('排比'), '应带上具体问题');

  assert.ok(!article.contentHtml.includes('综上所述'), '最终应是重写后的版本');
  assert.ok(article.humanScore > 70, `重写后应达标，实际 ${article.humanScore}`);
});

test('达标时不触发重写', async () => {
  config.articleStyle.rewriteRounds = 2;
  state.queue = [GOOD_BODY];

  await generateArticle(TOPIC);
  assert.equal(state.requests.length, 1);
});

test('重写后仍不达标时，返回分最高的那一版而不是 null', async () => {
  config.articleStyle.rewriteRounds = 1;
  state.queue = [BAD_BODY];

  const article = await generateArticle(TOPIC);

  assert.ok(article, '不该返回 null');
  assert.equal(state.requests.length, 2, '轮次用尽后停止');
  assert.ok(article.humanScore < 70);
});

test('段落打散只在提分时保留，不会把分数改差', async () => {
  state.queue = [GOOD_BODY];
  const article = await generateArticle(TOPIC);

  // 打散带随机性，但"只在 afterScore >= beforeScore 时才保留"是硬保证，
  // 所以最终分不可能低于"只做去套话、不打散"的那一版
  const humanizedOnly = humanizeContent(GOOD_BODY).text;
  assert.ok(
    article.humanScore >= scoreHumanity(humanizedOnly).score,
    `打散后不应降分：${article.humanScore} < ${scoreHumanity(humanizedOnly).score}`
  );
});

test('模型没输出 JSON 时走容错解析，仍能捞回正文', async () => {
  state.rawMode = true;
  state.queue = ['抱歉，我直接写正文：<p>这是没有 JSON 结构的正文内容，但是长度足够被识别成段落。</p>'];
  const article = await generateArticle(TOPIC);

  assert.ok(article, '容错解析应能返回文章');
  assert.ok(article.contentHtml.includes('没有 JSON 结构的正文内容'));
  assert.equal(article.title, '热点文章', '取不到标题时用兜底标题');
  assert.ok(!/<p[^>]*>\s*<p/i.test(article.contentHtml), '不应套出嵌套 <p>');
});

test('容错解析路径同样要做去AI味处理，不能静默跳过整条反检测链路', async () => {
  state.rawMode = true;
  state.queue = [
    '好吧我直接写：<p>综上所述，在当今社会，这类话题无疑是值得我们深入思考的，而且这段话得足够长才能被容错解析识别成一个段落。</p>',
  ];
  const article = await generateArticle(TOPIC);

  assert.ok(article, '容错解析应能返回文章');
  assert.ok(!article.contentHtml.includes('综上所述'), '容错路径也必须替换AI套话');
  assert.ok(!article.contentHtml.includes('在当今社会'), '容错路径也必须替换AI套话');
  assert.equal(typeof article.humanScore, 'number', '容错路径也要有人味分');
  assert.ok(article.humanReport, '容错路径也要产出体检报告');
});

test('容错解析路径不能把固定尾部注入两次', async () => {
  state.rawMode = true;
  state.queue = ['<p>这是一段没有 JSON 结构的正文，长度足够被容错解析当成一个正常段落来处理。</p>'];
  const article = await generateArticle(TOPIC);

  const footerCount = (article.contentHtml.match(/— END —/g) || []).length;
  assert.equal(footerCount, 1, `尾部应只出现一次，实际 ${footerCount} 次`);
});

test('重写反而更差时，返回第一版而不是更差的第二版', async () => {
  // 先分别测出两版各自的最终分（rewriteRounds=0 → 只生成一版）
  config.articleStyle.rewriteRounds = 0;
  state.queue = [BAD_BODY];
  const first = await generateArticle(TOPIC);
  state.queue = [WORSE_BODY];
  const second = await generateArticle(TOPIC);

  assert.ok(
    first.humanScore > second.humanScore,
    `前提：第一版应更好（${first.humanScore} vs ${second.humanScore}）`
  );
  assert.ok(second.humanScore < 70, '前提：两版都不达标，否则不会走到重写分支');

  // 再构造"重写产出了一版更差的"
  config.articleStyle.rewriteRounds = 1;
  state.requests = []; // 前面两次探分也发了请求，这里清掉才好断言轮次
  state.queue = [BAD_BODY, WORSE_BODY];
  const article = await generateArticle(TOPIC);

  assert.equal(state.requests.length, 2, '两版都生成了');
  assert.equal(article.humanScore, first.humanScore, '应保留分更高的第一版，而不是更差的第二版');
});

test('模型输出被截断时明确失败，不把半成品当成功', async () => {
  // 模拟撞上 max_tokens：响应被切断，返回的 JSON 一定是残缺的
  state.finishReason = 'length';
  state.queue = ['{"title":"半截标题","digest":"半截摘要","contentHtml":"<p>这篇文章写到一半就断了'];

  const article = await generateArticle(TOPIC);

  assert.equal(article, null, '截断应判为失败——半成品绝不能推进草稿箱');
});

test('截断错误不重试：参数没变，重试只会再截断一次', async () => {
  config.ai.maxRetries = 2; // 调高重试次数，用来验证它确实没被重试
  state.finishReason = 'length';
  state.queue = ['<p>随便一段。</p>'];

  await generateArticle(TOPIC);

  assert.equal(state.requests.length, 1, '截断不可重试，只应发出一次请求');
});

/** 取出实际发出去的 system prompt */
async function captureSystemPrompt() {
  state.queue = [GOOD_BODY];
  await generateArticle(TOPIC);
  return state.requests[0].messages[0].content;
}

/** 取出实际发出去的用户提示词里的【话题信息】那一段 */
async function captureTopicBlock(topic) {
  state.queue = [GOOD_BODY];
  await generateArticle(topic);
  const user = state.requests[0].messages[1].content;
  const start = user.indexOf('【话题信息】');
  const end = user.indexOf('【写作要求】');
  assert.ok(start >= 0 && end > start, '用户提示词里应有【话题信息】段');
  return user.slice(start, end);
}

test('摘要为空时整行不输出，而不是留一个空的"背景："', async () => {
  const block = await captureTopicBlock({ ...TOPIC, summary: '' });

  assert.ok(block.includes('标题：测试话题'), '标题行必须还在');
  assert.ok(block.includes('来源：微博热搜（热度排名第1位）'), '来源行必须还在');
  assert.ok(
    !block.includes('背景'),
    `拿不到背景时不该出现"背景"两个字（空的也不行），实际：\n${block}`
  );
});

test('有摘要时"背景"行正常输出', async () => {
  const block = await captureTopicBlock({ ...TOPIC, summary: '热度 60.0万' });

  assert.ok(block.includes('背景：热度 60.0万'), `实际：\n${block}`);
});

/*
 * 为什么单独钉住这几句：提示词原来写"至少 3 处**具体到不能编造**的细节"。
 * 本意是"别编"，模型却读成了"要非常具体"，于是**为了满足这一条去编数字和原话**。
 * 实测（真实模型，输入只有"标题 + 【新】热度 272.6万"）产出的正文里有：
 *   8点07分 / 12分47秒 / 播放800万 / 起售价12999元 / 电池健康79% / 延保199元 / 维修报价4680元
 * ——这些数字输入里一个都没有。还有直接引语被安到真实博主头上。
 * 而打分器的"具体细节密度"这一项**只数数字和引号，不检查真假**，那一版该项满分 100。
 * 也就是说：这条要求 + 这个指标，合起来是在**奖励编造**。
 * 下面几句就是把这个漏洞堵上，删掉任何一句都会让模型重新有动力去编。
 */
test('提示词明确禁止为了"具体"而编造数字与当事人原话', async () => {
  const system = await captureSystemPrompt();

  assert.ok(system.includes('绝不等于'), '应点明"具体"不等于"编造"');
  assert.ok(system.includes('编造比不够具体严重得多'), '应给出优先级：宁可不具体也别编');
  assert.ok(system.includes('禁止虚构引号里的原话'), '应点名禁止虚构原话安到真人头上');
  assert.ok(system.includes('凑不够 3 处就少写几处'), '应给模型留"凑不够就别凑"的出口');
  assert.ok(system.includes('不来自数字和引号的密度'), '应说明真实感不来自数字密度');
});

/*
 * 溯源检查：把"正文里有、但话题输入里没有"的具体信息挂到 article 上，并打一条 warn。
 * 它不判定造假（文章引用真实公共事实也会被列出来），价值在于让编造**看得见**——
 * 在此之前，模型编的"维修报价 4680 元"会一路静默地推进草稿箱，而自检分还很高。
 */
test('生成后附上"无法从输入溯源"的具体信息，供人工核对', async () => {
  state.queue = ['<p>这个词条热度 272.6 万，排在第1位，维修报价 4680 元。</p>'];

  const article = await generateArticle({
    id: 't1',
    title: '测试话题',
    summary: '【新】热度 272.6万',
    source: 'weibo',
    rank: 1,
  });

  assert.ok(article.untraceableSpecifics, 'article 上应带溯源检查结果');
  const { numbers } = article.untraceableSpecifics;

  assert.ok(numbers.includes('4680'), `输入里没有的报价应被标出，实际：${numbers.join(', ')}`);
  assert.ok(!numbers.includes('272'), '输入里已有的热度不该被标出');
  assert.ok(!numbers.includes('1'), '输入里已有的排名不该被标出');
});

test('话题输入能解释正文里的数字时，不产生可疑项', async () => {
  state.queue = ['<p>热度 272.6 万，排在第1位。</p>'];

  const article = await generateArticle({
    id: 't1',
    title: '测试话题',
    summary: '【新】热度 272.6万',
    source: 'weibo',
    rank: 1,
  });

  assert.deepEqual(article.untraceableSpecifics.numbers, [], '数字都能溯源时列表应为空');
});

test('提示词里的阈值直接引用 HUMANITY_TARGETS，改阈值不用改两处', async () => {
  const system = await captureSystemPrompt();
  const T = HUMANITY_TARGETS;

  assert.ok(system.includes(`句长标准差/均值 ≥ ${T.sentenceLenCV}`), '句长变异系数应引用常量');
  assert.ok(system.includes(`段落长度变异系数 ≥ ${T.paraLenCV}`), '段落变异系数应引用常量');
});

/*
 * 关于"短句占比不达标"——这里记录一个**试过但已回退**的方向，别再重复踩：
 *
 * 提示词原来写"全文至少 3 句不超过 8 个字"，而打分器算的是"≤10 字句占比 ≥ 18%"，
 * 看起来是条数 vs 占比的口径错配（长文按条数要求必然不达标）。
 * 于是改成占比表述、并把标点要求从 3 种提到 6 种。
 *
 * 实测结果（真实模型，同一话题，max_tokens=8192）：
 *   旧提示词 n=4：分数 90/87/78/78，均 83.3；短句占比均 14.2%；句长CV 均 0.591
 *   新提示词 n=3：分数 87/77/74（另 1 次截断失败），均 79.3；短句占比均 13.2%；句长CV 均 0.569
 *
 * 结论：**改了没用，甚至略差，已回退**。把要求写得更狠并不能让模型多写短句——
 * 这个模型在这种文风下就是只产出 ~14% 短句，18% 的目标超出其自然范围。
 * 而且组内差异（12 分）远大于组间差异（4 分），n=3~4 根本区分不开两个提示词。
 *
 * 教训：**n=1 的样本不能用来判断提示词改动有没有效**。之前拿单次 82 分当基线、
 * 又拿单次 75 分当"回归"，两次都是在读噪声。
 */
