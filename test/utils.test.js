import test from 'node:test';
import assert from 'node:assert/strict';
import {
  topicId,
  isAdTopic,
  computeViralScore,
  formatHot,
  getLabelMultiplier,
} from '../src/utils/cache.js';
import { dedupeBy, truncate, isRetryableError, withRetry, localDateKey, createDedupeCache, sleep, insertImages } from '../src/utils/helpers.js';
import { toClaudeMessages } from '../src/ai/client.js';

test('topicId 对同一标题稳定，不同标题不同', () => {
  assert.equal(topicId('今天天气不错'), topicId('今天天气不错'));
  assert.notEqual(topicId('今天天气不错'), topicId('明天天气不错'));
  assert.equal(topicId('abc').length, 12);
});

test('computeViralScore 随排名下降而降低', () => {
  const first = computeViralScore(1, 30, 1_000_000, '');
  const last = computeViralScore(30, 30, 1_000_000, '');
  assert.ok(first > last, '第 1 名得分应高于第 30 名');
});

test('computeViralScore 中"爆"标签权重高于"热"', () => {
  const hot = computeViralScore(5, 30, 100_000, '爆');
  const warm = computeViralScore(5, 30, 100_000, '热');
  assert.ok(hot > warm);
});

test('computeViralScore 对异常 topN 不会除零', () => {
  assert.ok(Number.isFinite(computeViralScore(1, 0, 0, '')));
});

test('getLabelMultiplier 未知标签回退为 1', () => {
  assert.equal(getLabelMultiplier('不存在'), 1);
  assert.equal(getLabelMultiplier(''), 1);
  assert.equal(getLabelMultiplier('爆'), 3);
});

test('isAdTopic 能识别广告词条', () => {
  assert.equal(isAdTopic('限时折扣扫码领红包'), true);
  assert.equal(isAdTopic('某地暴雨橙色预警'), false);
});

test('formatHot 按量级格式化', () => {
  assert.equal(formatHot(0), '0');
  assert.equal(formatHot(25_000), '2.5万');
  assert.equal(formatHot(150_000_000), '1.5亿');
});

test('dedupeBy 保留首次出现的元素', () => {
  const out = dedupeBy(
    [{ id: 'a', v: 1 }, { id: 'b', v: 2 }, { id: 'a', v: 3 }],
    (x) => x.id
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].v, 1);
});

test('truncate 仅在超长时截断', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 3), 'abc...(已截断)');
  assert.equal(truncate(null, 3), '');
});

test('isRetryableError 区分可重试与不可重试错误', () => {
  assert.equal(isRetryableError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableError({ response: { status: 429 } }), true);
  assert.equal(isRetryableError({ response: { status: 503 } }), true);
  assert.equal(isRetryableError({ response: { status: 400 } }), false);
  assert.equal(isRetryableError({ response: { status: 401 } }), false);
});

test('withRetry 遇到可重试错误后会成功', async () => {
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' });
      return 'ok';
    },
    { retries: 3, baseDelayMs: 1 }
  );
  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('withRetry 遇到不可重试错误立即抛出', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          attempts++;
          throw Object.assign(new Error('bad request'), { response: { status: 400 } });
        },
        { retries: 3, baseDelayMs: 1 }
      ),
    /bad request/
  );
  assert.equal(attempts, 1, '4xx 不应重试');
});

test('localDateKey 输出 YYYY-MM-DD', () => {
  assert.match(localDateKey(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('createDedupeCache 屏蔽重复 key', () => {
  const cache = createDedupeCache(1000, 10);
  assert.equal(cache.seen('m1'), false);
  assert.equal(cache.seen('m1'), true);
  assert.equal(cache.seen('m2'), false);
  assert.equal(cache.seen(''), false, '空 key 不参与去重');
});

test('createDedupeCache 过期后可再次命中', async () => {
  const cache = createDedupeCache(20, 10);
  cache.seen('m1');
  await sleep(30);
  assert.equal(cache.seen('m1'), false);
});

test('toClaudeMessages 把连续 tool 结果合并进同一条 user 消息', () => {
  const messages = toClaudeMessages([
    { role: 'user', content: '看看热点' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', function: { name: 'crawl_weibo', arguments: '{}' } },
        { id: 'c2', function: { name: 'crawl_douyin', arguments: '{}' } },
      ],
    },
    { role: 'tool', content: 'r1', tool_call_id: 'c1' },
    { role: 'tool', content: 'r2', tool_call_id: 'c2' },
  ]);

  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user']);

  const toolResults = messages[2].content;
  assert.equal(toolResults.length, 2);
  assert.deepEqual(toolResults.map((b) => b.tool_use_id), ['c1', 'c2']);
});

test('toClaudeMessages 把 assistant 文本与 tool_use 放在同一条消息里', () => {
  const messages = toClaudeMessages([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '我来查一下',
      tool_calls: [{ id: 'c1', function: { name: 'get_system_status', arguments: '{}' } }],
    },
    { role: 'tool', content: '{}', tool_call_id: 'c1' },
  ]);

  const assistant = messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content.map((b) => b.type), ['text', 'tool_use']);
});

// ===== insertImages =====

const countImgs = (html) => (html.match(/<img /g) || []).length;

test('insertImages 无图/无正文时原样返回', () => {
  const html = '<p>a</p><p>b</p>';
  assert.equal(insertImages(html, []), html);
  assert.equal(insertImages(html, null), html);
  assert.equal(insertImages('', ['u1']), '');
  assert.equal(insertImages(null, ['u1']), '');
  // 空串 URL 要被过滤掉，不能生成 src="" 的坏图
  assert.equal(insertImages(html, ['', null, undefined]), html);
});

test('insertImages 插入的图片数量与段落数取小', () => {
  const html = '<p>1</p><p>2</p><p>3</p><p>4</p><p>5</p>';
  assert.equal(countImgs(insertImages(html, ['a'])), 1);
  assert.equal(countImgs(insertImages(html, ['a', 'b'])), 2);
  // 图比段多：最后一段不插图，所以 5 段最多只能插 4 张
  assert.equal(countImgs(insertImages(html, ['a', 'b', 'c', 'd', 'e', 'f'])), 4);
});

test('insertImages 不会把图片插到最后一段之后', () => {
  const html = '<p>1</p><p>2</p><p>3</p>';
  const out = insertImages(html, ['a', 'b', 'c']);
  assert.ok(!/<\/p>\s*<p[^>]*>\s*<img[^>]*>\s*$/.test(out.trim()), '末尾不应以图片收尾');
  assert.ok(out.trim().endsWith('</p>'), `正文应以段落结尾，实际: ${out.trim().slice(-40)}`);
});

test('insertImages 不会把图片塞在小标题和它下面第一段之间', () => {
  const html = '<p>1</p><h2>小标题</h2><p>2</p><p>3</p>';
  const out = insertImages(html, ['a']);
  assert.ok(
    !/<\/h2>\s*<p[^>]*>\s*<img/.test(out),
    `小标题后不应紧跟图片，实际: ${out}`
  );
});

test('insertImages 保留原有正文内容，只做插入', () => {
  const html = '<p>1</p><p>2</p><p>3</p>';
  const out = insertImages(html, ['a', 'b']);
  for (const frag of ['<p>1</p>', '<p>2</p>', '<p>3</p>']) {
    assert.ok(out.includes(frag), `应保留 ${frag}`);
  }
  assert.equal(out.replace(/<p style="margin: 24px 0; text-align: center;">.*?<\/p>/g, ''), html);
});

test('insertImages 正文没有 p 标签时退化为追加到末尾', () => {
  const html = '<h2>只有标题</h2>';
  const out = insertImages(html, ['a', 'b']);
  assert.equal(countImgs(out), 2);
  assert.ok(out.startsWith(html));
});

test('insertImages 对图片 URL 里的引号做转义，避免破坏标签', () => {
  const out = insertImages('<p>1</p><p>2</p>', ['http://x/a"onerror="alert(1)']);
  assert.ok(!out.includes('"onerror="'), '引号应被转义，不能注入属性');
  assert.ok(out.includes('&quot;'));
});

