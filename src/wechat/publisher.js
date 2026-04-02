/**
 * 微信公众号推送模块
 * 流程：获取 AccessToken → 创建草稿
 */
import axios from 'axios';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import config from '../../config/index.js';
import logger from '../utils/logger.js';

const { apiBase, appId, appSecret } = config.wechat;

// ===== AccessToken 管理（带文件缓存）=====
let _tokenCache = null;

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
  if (!appId || !appSecret) {
    logger.error('微信 AppID / AppSecret 未配置');
    return null;
  }
  try {
    const { data } = await axios.get(`${apiBase}/cgi-bin/token`, {
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
      `${apiBase}/cgi-bin/material/batchget_material`,
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
  const materials = await getMaterialList();
  if (!materials || materials.length === 0) {
    logger.error('无法获取封面图media_id，素材库中没有图片');
    return null;
  }
  
  // 返回第一个图片的media_id
  const firstMaterial = materials[0];
  logger.info(`使用素材库中的图片作为封面: ${firstMaterial.media_id}`);
  return firstMaterial.media_id;
}

// ===== 创建草稿 =====
async function createDraft({ title, contentHtml, digest, thumbMediaId, author = 'AI创作' }) {
  const token = await getAccessToken();
  if (!token) return null;

  const article = {
    title,
    author,
    digest: digest.slice(0, 120),
    content: wrapHtml(contentHtml),
    content_source_url: '',
    need_open_comment: 1,
    only_fans_can_comment: 0,
  };
  
  // 如果有有效的thumbMediaId，添加到article对象中
  if (thumbMediaId) {
    article.thumb_media_id = thumbMediaId;
    logger.info(`使用封面图media_id: ${thumbMediaId}`);
  }
  
  logger.info(`发送到微信API的article对象: ${JSON.stringify(article)}`);

  try {
    const { data } = await axios.post(
      `${apiBase}/cgi-bin/draft/add`,
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

// ===== 完整发布流程 =====
/**
 * @param {object} article  { title, contentHtml, digest }
 * @returns {Promise<string|null>} 草稿 media_id
 */
export async function publishToDraft(article) {
  logger.info(`推送文章到公众号草稿箱：${article.title}`);

  // 从素材库获取封面图media_id
  const thumbMediaId = await getCoverMediaId();
  if (!thumbMediaId) {
    logger.error('无法获取封面图media_id，草稿创建失败');
    return null;
  }

  // 创建草稿
  const draftId = await createDraft({
    title: article.title,
    contentHtml: article.contentHtml,
    digest: article.digest,
    thumbMediaId,
  });

  if (draftId) logger.info(`✅ 已推送至草稿箱！ID: ${draftId}`);
  else logger.error('❌ 草稿推送失败');

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
