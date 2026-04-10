/**
 * 主流程端到端测试
 *
 * 覆盖 runPipeline 的完整链路：爬取 → 批内去重 → 历史去重 → 生成文章 → 登记 / 推送。
 *
 * 外部依赖的处理方式：
 *   - 微博接口、豆包接口 → 指向本地 mock 服务
 *   - 微信推送、飞书通知 → 不 mock，靠 dryRun 直接跳过（"试运行必须零副作用"正是要验证的点）
 *   - 去重缓存 → 重定向到临时文件，绝不碰用户真实的 .cache/processed_topics.json
 *
 * main.js 有"只有直接执行才启动"的守卫，所以这里 import 它是安全的。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import config from '../config/index.js';
import logger, { flushLogs } from '../src/utils/logger.js';
import { loadProcessed, topicId } from '../src/utils/cache.js';

const TOPIC_TITLE = '端到端测试专用热点话题';
const ARTICLE = {
  title: '端到端测试生成的文章标题',
  digest: '端到端测试摘要',
  contentHtml: '<p>端到端测试正文</p>',
  keywords: ['测试'],
  imageQuery: 'test',
};

// ===== mock 服务 =====

function startMockServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    // 见 crawler.test.js：有 HTTP_PROXY 时 req.url 可能是绝对形式
    const pathname = new URL(req.url, 'http://localhost').pathname;
    hits.push(pathname);

    if (pathname === '/weibo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: { realtime: [{ word: TOPIC_TITLE, num: 1_234_567, label_name: '爆', category: '社会' }] },
        })
      );
      return;
    }

    if (pathname === '/chat/completions') {
      // 豆包走 OpenAI 兼容协议，这里返回一个最简 completion
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(ARTICLE) } }] }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        hits,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ===== 夹具 =====

let mock;
let runPipeline;
let tempCacheFile;
const saved = {};

const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** 读取日志文件自 offset 字节之后新增的内容（按字节切片，避免多字节字符错位） */
function readLogSince(offset) {
  const file = join(config.log.dir, `${localDate()}.log`);
  if (!existsSync(file)) return '';
  return readFileSync(file).subarray(offset).toString('utf-8');
}

before(async () => {
  // 预热重量级懒加载依赖，理由同 crawler.test.js
  await import('cheerio');

  mock = await startMockServer();

  // 快照，after 里原样还原
  Object.assign(saved, {
    weiboUrl: config.crawler.weiboUrl,
    cacheFile: config.cacheFile,
    doubaoBaseUrl: config.ai.doubaoBaseUrl,
    doubaoKey: config.ai.doubaoKey,
    provider: config.ai.provider,
    wechatAppId: config.wechat.appId,
    feishuAppId: config.feishu.appId,
  });

  // 把两个外部依赖指向 mock。provider 固定为 doubao，
  // 让用例不依赖本机 .env 里选的是哪家 —— 否则换个机器测试就会走别的分支。
  config.crawler.weiboUrl = `${mock.base}/weibo`;
  config.ai.doubaoBaseUrl = mock.base;
  config.ai.doubaoKey = 'test-key';
  config.ai.provider = 'doubao';

  ({ runPipeline } = await import('../src/main.js'));
});

after(async () => {
  Object.assign(config.crawler, { weiboUrl: saved.weiboUrl });
  Object.assign(config.ai, {
    doubaoBaseUrl: saved.doubaoBaseUrl,
    doubaoKey: saved.doubaoKey,
    provider: saved.provider,
  });
  config.cacheFile = saved.cacheFile;
  config.wechat.appId = saved.wechatAppId;
  config.feishu.appId = saved.feishuAppId;

  await mock.close();
  if (tempCacheFile && existsSync(tempCacheFile)) rmSync(tempCacheFile, { force: true });
});

// ===== 用例 =====

test('试运行：完整跑通链路，但不推送、不通知、不写去重缓存', async () => {
  tempCacheFile = join(tmpdir(), `oap-test-processed-${process.pid}-dry.json`);
  if (existsSync(tempCacheFile)) rmSync(tempCacheFile, { force: true });
  config.cacheFile = tempCacheFile;
  // 故意把微信配成"已配置"，确保跳过推送是 dryRun 起作用，而不是靠"未配置"侥幸跳过
  config.wechat.appId = 'should-not-be-used';
  config.feishu.appId = 'should-not-be-used';

  const logOffset = existsSync(join(config.log.dir, `${localDate()}.log`))
    ? statSync(join(config.log.dir, `${localDate()}.log`)).size
    : 0;

  const result = await runPipeline(['weibo'], 1, { dryRun: true });
  await flushLogs();

  assert.equal(result.success, 1, '应成功生成 1 篇');
  assert.equal(result.total, 1);
  assert.equal(result.published, 0, '试运行不得推送任何草稿');
  assert.equal(result.dryRun, true, '返回值应标明这是试运行');

  assert.ok(mock.hits.includes('/chat/completions'), '应真的调用了 AI 接口');
  assert.ok(!existsSync(tempCacheFile), '试运行不得写入去重缓存（否则真跑时这些话题会被跳过）');

  const appended = readLogSince(logOffset);
  assert.ok(appended.includes('试运行：跳过推送草稿箱'), '日志应说明跳过了推送');
  assert.ok(appended.includes('试运行：跳过飞书通知'), '日志应说明跳过了飞书通知');
  assert.ok(!appended.includes('推送至微信草稿箱'), '日志中不应出现真正的推送动作');
});

test('非试运行：生成后写入去重缓存，并记录统计', async () => {
  tempCacheFile = join(tmpdir(), `oap-test-processed-${process.pid}-real.json`);
  if (existsSync(tempCacheFile)) rmSync(tempCacheFile, { force: true });
  config.cacheFile = tempCacheFile;
  // 关掉微信/飞书，让用例不产生任何真实外部副作用（这是唯一安全的做法）
  config.wechat.appId = '';
  config.feishu.appId = '';

  const result = await runPipeline(['weibo'], 1);
  await flushLogs();

  assert.equal(result.success, 1);
  assert.equal(result.published, 0, '微信未配置时不应推送');
  assert.equal(result.dryRun, false);

  assert.ok(existsSync(tempCacheFile), '正常流程应写入去重缓存');
  assert.ok(loadProcessed().has(topicId(TOPIC_TITLE)), '该话题应被登记为已处理');

  // 再跑一次：同一话题已被登记，应被历史去重挡掉
  const second = await runPipeline(['weibo'], 1);
  assert.equal(second.success, 0, '已处理过的话题不应重复生成');
  assert.equal(second.total, 0);
});
