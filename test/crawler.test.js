/**
 * 爬虫测试（本地 mock 服务）
 *
 * 为什么不打真实接口：微博 / 抖音 / tenapi 会风控、限流、随时改字段，
 * 拿它们当自动化测试的依赖只会得到一堆随机失败。
 * 这里在本地起一个 HTTP 服务，把 config.crawler 里的地址改指向它，
 * 验证"拿到响应之后解析得对不对"——这部分才是我们自己的逻辑。
 *
 * 覆盖：三级兜底的正常路径与降级链路、广告过滤、排名连续性、爆点标签映射、HTML 清洗。
 *
 * 环境提示：若环境变量里有 HTTP_PROXY（CI / 沙箱常见），axios 会把请求走代理转发，
 * 请求行会变成绝对形式。mock 服务已做兼容，无需额外设置 NO_PROXY。
 */
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import config from '../config/index.js';

// ===== 本地 mock 服务 =====

const WEIBO_OFFICIAL_BODY = {
  data: {
    realtime: [
      { word: '某地突发暴雨', num: 1_200_000, label_name: '爆', category: '社会', note: '<b>暴雨</b>导致多地积水' },
      { word: '明星演唱会门票开售', num: 800_000, label_name: '热', category: '娱乐' },
      // 以下三条都应被过滤：标签命中商业标签 / 标题命中广告词
      { word: '某品牌限时折扣活动', num: 500_000, label_name: '广告' },
      { word: '电视剧《某剧》今晚开播', num: 400_000, label_name: '电视剧' },
      { word: '转发锦鲤抽奖福利', num: 100_000, label_name: '新' },
      // HTML 标签应被清洗
      { word: '<em>测试</em>话题标题', num: 300_000 },
    ],
  },
};

const WEIBO_TENAPI_BODY = {
  code: 200,
  data: [
    { name: '第三方热点一', hot: '1234567' },
    { name: '扫码领红包活动', hot: '1000' },
    { name: '第三方热点二', hot: '5000' },
  ],
};

const WEIBO_BACKUP_HTML = `
<table>
  <tr><td class="td-02"><a href="/a">网页热点一</a></td></tr>
  <tr><td class="td-02"><a href="/b">网页热点二</a></td></tr>
  <tr><td class="td-02"><a href="/c">免费领取福利</a></td></tr>
</table>`;

const DOUYIN_WEB_BODY = {
  data: {
    word_list: [
      { word_item: { word: '抖音热点一', hot_value: 5_000_000, label_type: 5 } },
      { word_item: { word: '带货直播预告', hot_value: 100, label_type: 1 } },
      { word_item: { word: '抖音热点二', hot_value: 3_000_000, label_type: 4 } },
    ],
  },
};

const DOUYIN_MOBILE_BODY = {
  word_list: [{ word: '移动端热点', hot_value: 2_000_000, label_type: 2 }],
};

const ROUTES = {
  '/weibo-official': () => ({ type: 'application/json', body: JSON.stringify(WEIBO_OFFICIAL_BODY) }),
  '/weibo-tenapi': () => ({ type: 'application/json', body: JSON.stringify(WEIBO_TENAPI_BODY) }),
  '/weibo-backup': () => ({ type: 'text/html; charset=utf-8', body: WEIBO_BACKUP_HTML }),
  '/douyin-web': () => ({ type: 'application/json', body: JSON.stringify(DOUYIN_WEB_BODY) }),
  '/douyin-mobile': () => ({ type: 'application/json', body: JSON.stringify(DOUYIN_MOBILE_BODY) }),
};

function startMockServer() {
  const server = http.createServer((req, res) => {
    // 注意 req.url 不一定是路径。如果环境里设了 HTTP_PROXY（CI、沙箱里很常见），
    // axios 会把请求交给代理，代理转发时用的是"绝对形式"请求行
    // （GET http://host:port/path HTTP/1.1），这时 req.url 是完整 URL。
    // 用 URL 解析才能在有代理 / 无代理两种环境下都正确匹配路由。
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const route = ROUTES[pathname];
    if (!route) {
      // 未注册的路径一律 404 —— 测试用它模拟"这一级接口挂了"
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const { type, body } = route();
    res.writeHead(200, { 'Content-Type': type });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ===== 夹具 =====

let mock;
const realUrls = {};

before(async () => {
  // 预热重量级懒加载依赖。cheerio 的首次 import 在冷缓存 / 受限环境里可能要几十秒，
  // 而网页兜底是"先 import cheerio、再发 HTTP 请求"——如果让这段加载卡在中间，
  // 本地 mock 的连接会被拖到被重置（表现为 ECONNRESET），测试就会假失败。
  // 在正常机器上这一步只要 ~100ms，等于空操作。
  await import('cheerio');

  mock = await startMockServer();
  for (const key of Object.keys(config.crawler)) {
    if (typeof config.crawler[key] === 'string' && config.crawler[key].startsWith('http')) {
      realUrls[key] = config.crawler[key];
    }
  }
});

// 每个用例开始前，把所有接口地址指向一个 404 路径。
// 这样"忘了覆盖某个 URL"只会得到一次快速 404，而不会去打真实网络、白等 15s 超时。
beforeEach(() => {
  for (const key of Object.keys(realUrls)) {
    config.crawler[key] = `${mock.base}/nope`;
  }
});

after(async () => {
  Object.assign(config.crawler, realUrls);
  await mock.close();
});

// ===== 微博 =====

test('微博官方 API：正常解析、过滤广告、排名不跳号、清洗 HTML', async () => {
  config.crawler.weiboUrl = `${mock.base}/weibo-official`;
  const { getWeiboHot } = await import('../src/crawlers/weibo.js');

  const topics = await getWeiboHot(5);

  assert.equal(topics.length, 3, '6 条里应有 3 条被过滤掉');
  assert.deepEqual(topics.map((t) => t.title), ['某地突发暴雨', '明星演唱会门票开售', '测试话题标题']);
  assert.deepEqual(topics.map((t) => t.rank), [1, 2, 3], '过滤后排名必须连续，不能跳号');
  assert.ok(topics.every((t) => t.source === 'weibo'));
  assert.ok(topics.every((t) => t.id && t.id.length > 0), '每条都应算出稳定 id');

  const [first] = topics;
  assert.equal(first.viralLabel, '爆', '官方爆点标签应被识别');
  assert.equal(first.hotValue, 1_200_000);
  assert.ok(first.summary.includes('【爆】'), '摘要应带上爆点标签');
  assert.ok(first.summary.includes('暴雨'), '摘要应来自 note 字段');

  assert.ok(first.viralScore > topics[2].viralScore, '带"爆"标签的分数应显著高于普通条目');
});

test('微博降级：官方接口失败时回退到第三方接口', async () => {
  // weiboUrl 保持 beforeEach 给的 404，只把第三方接口指向 mock
  config.crawler.weiboFallbackUrl = `${mock.base}/weibo-tenapi`;
  const { getWeiboHot } = await import('../src/crawlers/weibo.js');

  const topics = await getWeiboHot(5);

  assert.deepEqual(topics.map((t) => t.title), ['第三方热点一', '第三方热点二'], '广告词条应被过滤');
  assert.deepEqual(topics.map((t) => t.rank), [1, 2]);
  assert.equal(topics[0].hotValue, 1_234_567, '字符串热度应转成数字');
});

test('微博降级：官方与第三方都失败时用网页解析兜底', async () => {
  config.crawler.weiboBackupUrl = `${mock.base}/weibo-backup`;
  const { getWeiboHot } = await import('../src/crawlers/weibo.js');

  const topics = await getWeiboHot(5);

  assert.deepEqual(topics.map((t) => t.title), ['网页热点一', '网页热点二']);
  assert.deepEqual(topics.map((t) => t.rank), [1, 2]);
});

test('微博三级兜底全部失败时返回空数组，而不是抛错', async () => {
  // 三个 URL 都停在 beforeEach 给的 404
  const { getWeiboHot } = await import('../src/crawlers/weibo.js');

  const topics = await getWeiboHot(5);

  assert.deepEqual(topics, [], '爬虫失败必须优雅降级为空数组，不能把异常抛给主流程');
});

// ===== 抖音 =====
// 注意：getDouyinHot 里有 1~3s 的随机延迟（模拟真实访问、规避风控），所以这几个用例会慢一些。

test('抖音 Web API：正常解析、label_type 映射成爆点标签、排名不跳号', async () => {
  config.crawler.douyinUrl = `${mock.base}/douyin-web`;
  const { getDouyinHot } = await import('../src/crawlers/douyin.js');

  const topics = await getDouyinHot(5);

  assert.deepEqual(topics.map((t) => t.title), ['抖音热点一', '抖音热点二']);
  assert.deepEqual(topics.map((t) => t.rank), [1, 2], '广告被过滤后排名必须连续');
  assert.deepEqual(topics.map((t) => t.viralLabel), ['爆', '新'], 'label_type 5→爆、4→新');
  assert.ok(topics.every((t) => t.source === 'douyin'));
  assert.equal(topics[0].hotValue, 5_000_000);
  assert.ok(topics[0].summary.includes('【爆】'));
});

test('抖音降级：Web API 失败时回退到移动端接口', async () => {
  // douyinUrl 保持 404，只把移动端接口指向 mock
  config.crawler.douyinMobileUrl = `${mock.base}/douyin-mobile`;
  const { getDouyinHot } = await import('../src/crawlers/douyin.js');

  const topics = await getDouyinHot(5);

  assert.equal(topics.length, 1);
  assert.equal(topics[0].title, '移动端热点');
  assert.equal(topics[0].viralLabel, '热', 'label_type 2→热');
});

test('抖音三级兜底全部失败时返回空数组', async () => {
  const { getDouyinHot } = await import('../src/crawlers/douyin.js');

  const topics = await getDouyinHot(5);

  assert.deepEqual(topics, []);
});
