/**
 * 微信公众号推送模块
 * 流程：获取 AccessToken → （可选）搜图并上传 → 创建草稿
 *
 * 配图相关的两条硬约束（踩过坑，别改回去）：
 *   1. 正文里的 <img> 只认微信自己的域名。外部图片直链（比如图库原始地址）
 *      在公众号里不会渲染，必须先用 media/uploadimg 换成微信 CDN 的 URL。
 *   2. 封面 thumb_media_id 必须是**永久素材**的 media_id，临时素材的 id 不行。
 *      所以封面图走 material/add_material，且会占用你公众号的素材库配额。
 */
import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import config, { isImageEnabled } from '../../config/index.js';
import logger from '../utils/logger.js';
import { insertImages } from '../utils/helpers.js';
import { fetchImages, buildCreditHtml } from '../images/provider.js';

// 注意：这里不要在模块顶层把 config.wechat 解构出来。
// 解构会把 apiBase / appId 在 import 那一刻就固化下来，之后改 config 再也不生效
// （测试里想把 apiBase 指向本地 mock 服务就做不到了）。统一在调用时读。
const apiBase = () => config.wechat.apiBase;

// ===== AccessToken 管理（带文件缓存）=====
let _tokenCache = null;
// ===== 封面图 media_id 内存缓存 =====
let _coverMediaIdCache = null;

/**
 * 清空模块级内存缓存。仅供测试使用 ——
 * 这两个缓存是跨调用复用的，测试之间会互相污染，导致后面的用例看到前面留下的状态。
 */
export function resetPublisherCache() {
  _tokenCache = null;
  _coverMediaIdCache = null;
}

async function getAccessToken() {
  // 内存缓存
  if (_tokenCache && Date.now() < _tokenCache.expireAt - 60_000) {
    return _tokenCache.token;
  }
  // 文件缓存
  if (existsSync(config.tokenCacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(config.tokenCacheFile, 'utf-8'));
      if (Date.now() < cached.expireAt - 60_000) {
        _tokenCache = cached;
        return cached.token;
      }
    } catch {}
  }
  // 重新获取
  return fetchNewToken();
}

async function fetchNewToken() {
  const { appId, appSecret } = config.wechat;
  if (!appId || !appSecret) {
    logger.error('微信 AppID / AppSecret 未配置');
    return null;
  }
  try {
    const { data } = await axios.get(`${apiBase()}/cgi-bin/token`, {
      params: { grant_type: 'client_credential', appid: appId, secret: appSecret },
      timeout: 10_000,
    });
    if (!data.access_token) {
      logger.error(`获取微信Token失败: ${JSON.stringify(data)}`);
      return null;
    }
    const cache = {
      token: data.access_token,
      expireAt: Date.now() + (data.expires_in || 7200) * 1000,
    };
    _tokenCache = cache;
    mkdirSync(dirname(config.tokenCacheFile), { recursive: true });
    writeFileSync(config.tokenCacheFile, JSON.stringify(cache), 'utf-8');
    logger.info('微信AccessToken获取成功');
    return cache.token;
  } catch (err) {
    logger.error(`获取微信Token异常: ${err.message}`);
    return null;
  }
}

// ===== 获取素材库图片列表 =====
async function getMaterialList() {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const { data } = await axios.post(
      `${apiBase()}/cgi-bin/material/batchget_material`,
      {
        type: 'image',
        offset: 0,
        count: 20
      },
      {
        params: { access_token: token },
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        timeout: 10_000,
      }
    );

    if (data.item && data.item.length > 0) {
      logger.info(`获取到 ${data.item.length} 个图片素材`);
      return data.item;
    }
    logger.warn('素材库中没有图片');
    return null;
  } catch (err) {
    logger.error(`获取素材库图片异常: ${err.message}`);
    return null;
  }
}

// ===== 获取一个有效的封面图media_id =====
async function getCoverMediaId() {
  // 内存缓存，避免每次创建草稿都请求素材库 API
  if (_coverMediaIdCache) {
    logger.info(`使用缓存的封面图media_id: ${_coverMediaIdCache}`);
    return _coverMediaIdCache;
  }
  const materials = await getMaterialList();
  if (!materials || materials.length === 0) {
    logger.error('无法获取封面图media_id，素材库中没有图片');
    return null;
  }
  // 返回第一个图片的media_id
  const firstMaterial = materials[0];
  _coverMediaIdCache = firstMaterial.media_id;
  logger.info(`使用素材库中的图片作为封面: ${_coverMediaIdCache}`);
  return _coverMediaIdCache;
}

// ===== 创建草稿 =====
async function createDraft({ title, contentHtml, digest, thumbMediaId, author = '小远' }) {
  const token = await getAccessToken();
  if (!token) return null;

  const article = {
    title,
    author,
    digest: String(digest || '').slice(0, 120),
    content: wrapHtml(contentHtml),
    content_source_url: '',
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };
  
  // 如果有有效的thumbMediaId，添加到article对象中
  if (thumbMediaId) {
    article.thumb_media_id = thumbMediaId;
  }

  try {
    const { data } = await axios.post(
      `${apiBase()}/cgi-bin/draft/add`,
      { articles: [article] },
      {
        params: { access_token: token },
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        timeout: 30_000,
      }
    );

    if (data.media_id) {
      logger.info(`草稿创建成功: ${data.media_id}`);
      return data.media_id;
    }
    logger.error(`草稿创建失败: errcode=${data.errcode} errmsg=${data.errmsg}`);
    explainError(data.errcode);
    return null;
  } catch (err) {
    logger.error(`创建草稿异常: ${err.message}`);
    return null;
  }
}

// ===== 配图上传 =====
// Node 18+ 自带全局 FormData / Blob，配合 axios 1.x 能直接发 multipart，
// 不需要再引 form-data 包（那个包有已知漏洞，已经从依赖里删掉了）。

/** 从 content-type 推断扩展名：微信要求 multipart 里的文件名带正确后缀 */
function extFromContentType(contentType) {
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
  };
  return map[String(contentType || '').toLowerCase()] || 'jpg';
}

function imageToBlob(image) {
  return new Blob([image.buffer], { type: image.contentType || 'image/jpeg' });
}

function buildImageForm(image) {
  const form = new FormData();
  form.append('media', imageToBlob(image), `image.${extFromContentType(image.contentType)}`);
  return form;
}

/**
 * 上传图片作为**正文插图**，返回微信 CDN 上的 URL。
 * 用这个 URL 拼进正文，图片才会在公众号里正常显示。失败返回 null。
 */
export async function uploadContentImage(image) {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const { data } = await axios.post(`${apiBase()}/cgi-bin/media/uploadimg`, buildImageForm(image), {
      params: { access_token: token },
      timeout: 30_000,
      // 注意：不要手动设 Content-Type。multipart 的 boundary 由 axios 生成，
      // 手写 'multipart/form-data' 会把 boundary 丢掉，微信直接报错。
    });

    if (data?.url) return data.url;
    logger.warn(`正文配图上传失败: errcode=${data?.errcode} errmsg=${data?.errmsg}`);
    return null;
  } catch (err) {
    logger.warn(`正文配图上传异常: ${err.message}`);
    return null;
  }
}

/**
 * 上传图片作为**永久素材**，返回 { media_id, url }。
 * 只有永久素材的 media_id 才能当封面；同一个响应里也带 url，可以顺便当正文插图用。
 * 失败返回 null。
 */
export async function uploadPermanentImage(image) {
  const token = await getAccessToken();
  if (!token) return null;

  try {
    const { data } = await axios.post(`${apiBase()}/cgi-bin/material/add_material`, buildImageForm(image), {
      params: { access_token: token, type: 'image' },
      timeout: 30_000,
    });

    if (data?.media_id) {
      logger.info(`配图已上传为永久素材: ${data.media_id}`);
      return { media_id: data.media_id, url: data.url || '' };
    }
    logger.warn(`配图上传永久素材失败: errcode=${data?.errcode} errmsg=${data?.errmsg}`);
    return null;
  } catch (err) {
    logger.warn(`配图上传永久素材异常: ${err.message}`);
    return null;
  }
}

/**
 * 为文章准备配图：搜图 → 上传到微信 → 返回正文可用的 URL 与封面 media_id。
 *
 * 第一张图若开启 asCover，会走永久素材上传（一次请求同时拿到 media_id 和 url，
 * 封面和正文共用这一张，不必传两遍）；其余图片走正文插图接口。
 * 任何一步失败都只降级，不抛异常。
 */
async function prepareImages(article) {
  if (!isImageEnabled()) return { contentUrls: [], coverMediaId: null, images: [] };

  // keywords 可能是数组（generate_article 的返回）也可能是字符串（模型手写的），
  // 这里统一处理，避免 .join is not a function 这种低级错误把配图整条链路打断
  const kw = Array.isArray(article.keywords)
    ? article.keywords.join(' ')
    : String(article.keywords || '');
  const query = article.imageQuery || kw || article.title || '';
  const images = await fetchImages(query, config.image.count);
  if (images.length === 0) return { contentUrls: [], coverMediaId: null, images: [] };

  const contentUrls = [];
  let coverMediaId = null;

  for (let i = 0; i < images.length; i++) {
    const image = images[i];

    if (i === 0 && config.image.asCover) {
      const material = await uploadPermanentImage(image);
      if (material) {
        coverMediaId = material.media_id;
        if (material.url) contentUrls.push(material.url);
        continue;
      }
      logger.warn('封面素材上传失败，将退回素材库封面；该图继续按正文插图上传');
    }

    const url = await uploadContentImage(image);
    if (url) contentUrls.push(url);
  }

  return { contentUrls, coverMediaId, images };
}

// ===== 完整发布流程 =====
/**
 * @param {object} article  { title, contentHtml, digest, imageQuery?, keywords? }
 * @returns {Promise<string|null>} 草稿 media_id
 */
export async function publishToDraft(article) {
  logger.info(`推送文章到公众号草稿箱：${article.title}`);

  // 配图：整段包在 try 里。图库挂了、微信上传挂了，都只降级成"没配图"，
  // 绝不能因为配图问题把文章卡住不发。
  let contentHtml = article.contentHtml;
  let coverMediaId = null;
  try {
    const { contentUrls, coverMediaId: cid, images } = await prepareImages(article);
    coverMediaId = cid;
    if (contentUrls.length > 0) {
      contentHtml = insertImages(contentHtml, contentUrls);
      const credit = buildCreditHtml(images);
      if (credit) contentHtml += credit;
      logger.info(`正文已插入 ${contentUrls.length} 张配图`);
    }
  } catch (err) {
    logger.warn(`配图流程异常（不影响发布）: ${err.message}`);
  }

  // 封面：优先用配图，其次退回素材库第一张。
  // 封面是硬依赖——拿不到 media_id 草稿就创建不了，所以这里必须有一个兜底。
  const thumbMediaId = coverMediaId || (await getCoverMediaId());
  if (!thumbMediaId) {
    logger.error('无法获取封面图media_id，草稿创建失败');
    return null;
  }

  // 创建草稿
  const draftId = await createDraft({
    title: article.title,
    contentHtml,
    digest: article.digest,
    thumbMediaId,
  });

  if (draftId) {
    logger.info(`✅ 已推送至草稿箱！ID: ${draftId}`);
  } else {
    // 草稿失败有可能是素材已被删除，清掉缓存让下次重新拉取，
    // 否则缓存里的失效 media_id 会让后续每次发布都失败。
    // 用配图当封面时没有走这个缓存，清不清都无副作用，这里只在确实缓存过时才提示。
    if (_coverMediaIdCache) {
      logger.warn('草稿创建失败，清除封面图 media_id 缓存，下次将重新获取');
      _coverMediaIdCache = null;
    }
    logger.error('❌ 草稿推送失败');
  }

  return draftId;
}

// ===== 辅助 =====
function wrapHtml(content) {
  return `<style>
p{line-height:1.8;margin:16px 0;font-size:16px;color:#333}
h2{font-size:20px;font-weight:700;color:#1a1a1a;margin:24px 0 12px}
strong{color:#e44d26}
blockquote{border-left:4px solid #07C160;padding:12px 16px;background:#f0faf5;margin:16px 0;color:#555}
</style>${content}`;
}

const ERROR_MAP = {
  40001: 'AccessToken无效，检查AppID/AppSecret',
  48001: '接口没有权限，检查公众号功能权限',
  45009: '接口调用超过限制（每天上限）',
};
function explainError(code) {
  if (ERROR_MAP[code]) logger.warn(`错误原因: ${ERROR_MAP[code]}`);
}
