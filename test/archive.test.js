/**
 * 文章本地存档测试
 *
 * 不打任何网络：把 config.run.archiveDir 指向临时目录，
 * 验证 保存 → 列表 → 读取 的完整链路，以及覆盖幂等与目录穿越防护。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import config from '../config/index.js';

// 存档目录重定向到临时目录，测试结束（进程退出时）清理并还原
const tempDir = mkdtempSync(join(tmpdir(), 'oap-archive-test-'));
const savedDir = config.run.archiveDir;
config.run.archiveDir = tempDir;
process.on('exit', () => {
  config.run.archiveDir = savedDir;
  rmSync(tempDir, { recursive: true, force: true });
});

const { saveArticle, listArticles, getArticle } = await import('../src/articles/store.js');

const TOPIC = { id: 'abc123def456', title: '某地突发暴雨', source: 'weibo', rank: 1 };
const ARTICLE = {
  title: '暴雨之下，城市值得一次复盘',
  digest: '一场暴雨暴露出的，不只是排水问题。',
  contentHtml: '<p>正文第一段。</p><p>正文第二段。</p>',
  style: 'sharp',
  humanScore: 85,
};

test('保存后可列出、可读取，元数据完整', async () => {
  const key = saveArticle(ARTICLE, TOPIC, { dryRun: true });
  assert.ok(key, '应返回 date/id 形式的存档路径');

  const { articles, total } = listArticles();
  assert.equal(total, 1);
  const meta = articles[0];
  assert.equal(meta.title, ARTICLE.title);
  assert.equal(meta.topicTitle, TOPIC.title);
  assert.equal(meta.source, 'weibo');
  assert.equal(meta.style, 'sharp');
  assert.equal(meta.humanScore, 85);
  assert.equal(meta.dryRun, true);
  assert.ok(meta.createdAt, '应记录创建时间');

  const [date, id] = key.split('/');
  const full = getArticle(date, id);
  assert.equal(full.contentHtml, ARTICLE.contentHtml);
  assert.equal(full.meta.title, ARTICLE.title);
});

test('同一话题重复存档覆盖，不产生重复条目', async () => {
  saveArticle(ARTICLE, TOPIC, {});
  saveArticle({ ...ARTICLE, title: '改后的标题' }, TOPIC, {});

  const { articles } = listArticles();
  const same = articles.filter((a) => a.id === TOPIC.id);
  assert.equal(same.length, 1, '同 id 应覆盖而不是新增');
  assert.equal(same[0].title, '改后的标题');
});

test('getArticle 拒绝目录穿越与非法 id', async () => {
  assert.equal(getArticle('../..', TOPIC.id), null);
  assert.equal(getArticle('2026-01-01', '../etc'), null);
  assert.equal(getArticle('2026-01-01', ''), null);
  assert.equal(getArticle('not-a-date', TOPIC.id), null);
});

test('saveArticle 对非法 topic.id 返回 null 而不抛错', async () => {
  assert.equal(saveArticle(ARTICLE, { ...TOPIC, id: 'bad/id' }, {}), null);
});
