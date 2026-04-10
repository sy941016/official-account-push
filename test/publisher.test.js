/**
 * 公众号推送链路测试（含配图）
 *
 * 整条链路都不打真实接口：把 config.wechat.apiBase、config.image.unsplashApiBase
 * 一起指向本地 mock 服务，然后断言"发出去的请求长什么样"。
 * 这样既验证了配图编排逻辑，又不会往用户的公众号素材库真上传图片。
 *
 * 几个容易踩的点：
 *   - 微信 token 有文件缓存（config.tokenCacheFile），必须重定向到临时文件，
 *     否则测试会覆盖用户真实的 .cache/wechat_token.json。
 *   - publisher.js 里有模块级内存缓存（token / 封面 media_id），
 *     用例之间要 resetPublisherCache()，不然会看到上一个用例留下的状态。
 *   - 正文图片断言要检查"用的是微信返回的 URL"，不能是图库原始 URL ——
 *     这正是这一版要修的核心问题（外链图在公众号里不渲染）。
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import config from '../config/index.js';

// ===== mock 微信 / 图库服务 =====

/** mock 的可调状态，用例通过改它来构造不同场景 */
const state = {
  base: '',
  /** 图库搜索接口的响应状态码 */
  searchStatus: 200,
  /** 图库返回几张图 */
  photoCount: 2,
  /** 素材库里的图片 */
  materials: [{ media_id: 'MATERIAL_MEDIA_ID', name: '素材库图片.jpg' }],
  /** 图片下载接口是否可用 */
  downloadOk: true,
  /** media/uploadimg 是否成功 */
  uploadimgOk: true,
  /** material/add_material 是否成功 */
  permanentOk: true,
  hits: [],
  /** 最后一次 draft/add 的请求体 */
  draftBody: null,
  /** 所有 multipart 上传的元信息 */
  uploads: [],
};

const TOKEN = 'MOCK_ACCESS_TOKEN';
const PERM_MEDIA_ID = 'PERM_MEDIA_ID_FROM_LIBRARY';
const PERM_URL = 'https://mmbiz.qpic.cn/mock/perm_from_library.jpg';
const CONTENT_URL = 'https://mmbiz.qpic.cn/mock/content_from_uploadimg.jpg';

function readRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** 从 multipart body 里粗取字段名与文件名，确认用的是 'media' 字段且带正确后缀 */
function multipartFields(buf) {
  const text = buf.toString('latin1');
  return {
    // \b 很关键：不加的话 filename="x" 里的 name="x" 也会被匹配上
    fields: [...text.matchAll(/\bname="([^"]+)"/g)].map((m) => m[1]),
    filenames: [...text.matchAll(/\bfilename="([^"]+)"/g)].map((m) => m[1]),
  };
}

function startMockServer() {
  const server = http.createServer(async (req, res) => {
    // 见 crawler.test.js：环境有 HTTP_PROXY 时 req.url 可能是绝对形式
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    state.hits.push(`${req.method} ${pathname}`);

    const json = (obj, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    // ---- 图库搜索 ----
    if (pathname === '/search/photos') {
      if (state.searchStatus !== 200) {
        json({ errors: ['Invalid Access Token'] }, state.searchStatus);
        return;
      }
      const results = Array.from({ length: state.photoCount }, (_, i) => ({
        urls: { regular: `${state.base}/photo/${i + 1}.jpg` },
        user: { name: i === 0 ? '张三' : '李四' },
        links: { html: `https://unsplash.com/photos/${i + 1}` },
        width: 1600,
        height: 900,
      }));
      json({ results });
      return;
    }

    // ---- 图片下载 ----
    if (pathname.startsWith('/photo/')) {
      if (!state.downloadOk) {
        res.writeHead(404).end('not found');
        return;
      }
      const buf = Buffer.from('fake-jpeg-bytes');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }

    // ---- 微信 token ----
    if (pathname === '/cgi-bin/token') {
      json({ access_token: TOKEN, expires_in: 7200 });
      return;
    }

    // ---- 素材库列表 ----
    if (pathname === '/cgi-bin/material/batchget_material') {
      await readRequestBody(req);
      json({ item: state.materials, total_count: state.materials.length });
      return;
    }

    // ---- 正文插图上传 ----
    if (pathname === '/cgi-bin/media/uploadimg') {
      const body = await readRequestBody(req);
      state.uploads.push({
        endpoint: pathname,
        contentType: req.headers['content-type'] || '',
        ...multipartFields(body),
        bytes: body.length,
      });
      if (!state.uploadimgOk) {
        json({ errcode: 40001, errmsg: 'invalid credential' });
        return;
      }
      json({ url: CONTENT_URL });
      return;
    }

    // ---- 永久素材上传（封面）----
    if (pathname === '/cgi-bin/material/add_material') {
      const body = await readRequestBody(req);
      state.uploads.push({
        endpoint: pathname,
        type: url.searchParams.get('type'),
        contentType: req.headers['content-type'] || '',
        ...multipartFields(body),
        bytes: body.length,
      });
      if (!state.permanentOk) {
        json({ errcode: 45009, errmsg: 'reach max api daily quota limit' });
        return;
      }
      json({ media_id: PERM_MEDIA_ID, url: PERM_URL });
      return;
    }

    // ---- 创建草稿 ----
    if (pathname === '/cgi-bin/draft/add') {
      const body = await readRequestBody(req);
      state.draftBody = JSON.parse(body.toString('utf-8'));
      json({ media_id: 'DRAFT_MEDIA_ID' });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.base = `http://127.0.0.1:${server.address().port}`;
      resolve({ close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// ===== 夹具 =====

let server;
let publishToDraft;
let resetPublisherCache;
let tempTokenFile;
const saved = {};

const ARTICLE = {
  title: '配图测试文章',
  digest: '配图测试摘要',
  contentHtml: '<p>第一段</p><p>第二段</p><p>第三段</p><p>第四段</p>',
  keywords: ['科技'],
  imageQuery: 'technology city',
};

const draftContent = () => state.draftBody.articles[0].content;
const draftThumb = () => state.draftBody.articles[0].thumb_media_id;

before(async () => {
  // 预热懒加载依赖：provider.js 是 await import('axios')，
  // 沙箱里首次加载慢会把本地连接拖到被重置，表现为假失败
  await import('axios');

  server = await startMockServer();

  Object.assign(saved, {
    wechatApiBase: config.wechat.apiBase,
    wechatAppId: config.wechat.appId,
    wechatAppSecret: config.wechat.appSecret,
    tokenCacheFile: config.tokenCacheFile,
    provider: config.image.provider,
    unsplashKey: config.image.unsplashKey,
    unsplashApiBase: config.image.unsplashApiBase,
    count: config.image.count,
    asCover: config.image.asCover,
  });

  tempTokenFile = join(tmpdir(), `oap-test-wechat-token-${process.pid}.json`);
  if (existsSync(tempTokenFile)) rmSync(tempTokenFile, { force: true });

  config.wechat.apiBase = state.base;
  config.wechat.appId = 'test-appid';
  config.wechat.appSecret = 'test-appsecret';
  config.tokenCacheFile = tempTokenFile;

  config.image.provider = 'unsplash';
  config.image.unsplashKey = 'test-unsplash-key';
  config.image.unsplashApiBase = state.base;
  config.image.count = 2;
  config.image.asCover = true;

  ({ publishToDraft, resetPublisherCache } = await import('../src/wechat/publisher.js'));
});

after(async () => {
  config.wechat.apiBase = saved.wechatApiBase;
  config.wechat.appId = saved.wechatAppId;
  config.wechat.appSecret = saved.wechatAppSecret;
  config.tokenCacheFile = saved.tokenCacheFile;
  Object.assign(config.image, {
    provider: saved.provider,
    unsplashKey: saved.unsplashKey,
    unsplashApiBase: saved.unsplashApiBase,
    count: saved.count,
    asCover: saved.asCover,
  });

  await server.close();
  if (tempTokenFile && existsSync(tempTokenFile)) rmSync(tempTokenFile, { force: true });
});

beforeEach(() => {
  // 每个用例都从干净状态开始，否则 token / 封面 media_id 会串台
  resetPublisherCache();
  if (existsSync(tempTokenFile)) rmSync(tempTokenFile, { force: true });

  state.searchStatus = 200;
  state.photoCount = 2;
  state.materials = [{ media_id: 'MATERIAL_MEDIA_ID', name: '素材库图片.jpg' }];
  state.downloadOk = true;
  state.uploadimgOk = true;
  state.permanentOk = true;
  state.hits.length = 0;
  state.uploads.length = 0;
  state.draftBody = null;
});

// ===== 用例 =====

test('配图开启：正文用微信返回的 URL，封面用配图上传的永久素材', async () => {
  const draftId = await publishToDraft(ARTICLE);

  assert.equal(draftId, 'DRAFT_MEDIA_ID', '草稿应创建成功');

  // 封面必须是永久素材接口返回的 media_id，不能用图库 URL 或临时素材
  assert.equal(draftThumb(), PERM_MEDIA_ID);

  const content = draftContent();
  assert.ok(content.includes(PERM_URL), '正文应包含永久素材返回的 URL');
  assert.ok(content.includes(CONTENT_URL), '正文应包含 uploadimg 返回的 URL');
  assert.ok(
    !content.includes(`${state.base}/photo/`),
    '正文不能残留图库原始地址（外链图在公众号里不渲染）'
  );
  assert.equal((content.match(/<img /g) || []).length, 2, '应插入 2 张配图');
  assert.ok(content.includes('配图来自 Unsplash'), 'Unsplash 要求署名摄影师');
  assert.ok(content.includes('张三') && content.includes('李四'), '应列出摄影师姓名');
});

test('配图上传走的是 multipart，字段名为 media，且带正确后缀的文件名', async () => {
  await publishToDraft(ARTICLE);

  const perm = state.uploads.find((u) => u.endpoint === '/cgi-bin/material/add_material');
  const content = state.uploads.find((u) => u.endpoint === '/cgi-bin/media/uploadimg');

  assert.ok(perm, '应调用了永久素材接口');
  assert.ok(content, '应调用了正文插图接口');

  for (const up of [perm, content]) {
    assert.match(up.contentType, /^multipart\/form-data; boundary=/, '必须是 multipart 且带 boundary');
    assert.deepEqual(up.fields, ['media'], '字段名必须是 media');
    assert.deepEqual(up.filenames, ['image.jpg'], '文件名要带正确后缀，微信按后缀判类型');
    assert.ok(up.bytes > 0, '请求体不能为空');
  }
  assert.equal(perm.type, 'image', '永久素材必须带 type=image');
});

test('图库 Key 无效（401）：降级为素材库封面，正文无图，草稿照常创建', async () => {
  state.searchStatus = 401; // 401 不可重试，用例不会白等退避

  const draftId = await publishToDraft(ARTICLE);

  assert.equal(draftId, 'DRAFT_MEDIA_ID', '配图失败不能阻断发布');
  assert.equal(draftThumb(), 'MATERIAL_MEDIA_ID', '应退回素材库封面');
  assert.ok(!draftContent().includes('<img '), '正文不应有配图');
  assert.ok(!draftContent().includes('配图来自'), '没有配图就不该有署名');
});

test('图库搜不到结果：同样降级，不影响发布', async () => {
  state.photoCount = 0;

  const draftId = await publishToDraft(ARTICLE);

  assert.equal(draftId, 'DRAFT_MEDIA_ID');
  assert.equal(draftThumb(), 'MATERIAL_MEDIA_ID');
  assert.ok(!draftContent().includes('<img '));
});

test('图片下载失败：该张跳过，其余继续；封面退回素材库', async () => {
  state.downloadOk = false;

  const draftId = await publishToDraft(ARTICLE);

  assert.equal(draftId, 'DRAFT_MEDIA_ID');
  assert.equal(draftThumb(), 'MATERIAL_MEDIA_ID', '没有可用配图时退回素材库封面');
  assert.ok(!draftContent().includes('<img '));
});

test('永久素材上传失败：封面退回素材库，但这张图仍作为正文插图上传', async () => {
  state.permanentOk = false;

  const draftId = await publishToDraft(ARTICLE);

  assert.equal(draftId, 'DRAFT_MEDIA_ID');
  assert.equal(draftThumb(), 'MATERIAL_MEDIA_ID', '应退回素材库封面');
  // 第一张图没能成为封面，但要继续按正文插图上传，不能白白丢掉
  assert.ok(draftContent().includes(CONTENT_URL), '第一张图应降级为正文插图');
  assert.equal((draftContent().match(/<img /g) || []).length, 2);
});

test('IMAGE_AS_COVER=false：配图只进正文，封面仍取素材库', async () => {
  config.image.asCover = false;
  try {
    const draftId = await publishToDraft(ARTICLE);

    assert.equal(draftId, 'DRAFT_MEDIA_ID');
    assert.equal(draftThumb(), 'MATERIAL_MEDIA_ID');
    assert.equal((draftContent().match(/<img /g) || []).length, 2, '两张图都应进正文');
    assert.ok(
      !state.hits.some((h) => h.includes('add_material')),
      'asCover 关闭时不应调用永久素材接口（那是要占配额的）'
    );
  } finally {
    config.image.asCover = true;
  }
});

test('配图整体关闭（IMAGE_PROVIDER=none）：不搜图，行为与旧版一致', async () => {
  config.image.provider = 'none';
  try {
    const draftId = await publishToDraft(ARTICLE);

    assert.equal(draftId, 'DRAFT_MEDIA_ID');
    assert.equal(draftThumb(), 'MATERIAL_MEDIA_ID');
    assert.ok(!draftContent().includes('<img '));
    assert.ok(
      !state.hits.some((h) => h.includes('/search/photos')),
      '关闭配图后不应再请求图库'
    );
  } finally {
    config.image.provider = 'unsplash';
  }
});

test('配图和素材库都拿不到图：返回 null（封面是硬依赖，不能假装成功）', async () => {
  state.searchStatus = 401;
  state.materials = [];

  const draftId = await publishToDraft(ARTICLE);

  assert.equal(draftId, null, '没有封面时必须失败，而不是创建一个没有封面的草稿');
  assert.equal(state.draftBody, null, '不应调用 draft/add');
});
