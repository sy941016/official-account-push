/**
 * 图库配图模块
 *
 * 按关键词去图库搜图并下载，供公众号正文插图与封面使用。
 * 支持 Unsplash / Pexels —— 两家的响应结构不同，这里统一成
 *   { url, width, height, author, link }
 * 的数组，调用方不需要关心用的是哪一家。
 *
 * 设计原则：**配图是锦上添花，绝不能阻断发布。**
 * 所以所有失败路径都返回空数组 / null，不抛异常；搜不到图就退化成纯文字文章。
 */
import config, { isImageEnabled } from '../../config/index.js';
import logger from '../utils/logger.js';
import { withRetry } from '../utils/helpers.js';

const TIMEOUT = config.image.requestTimeoutMs;
/** 单张配图的下载上限，防止一个超大文件把内存吃掉 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** 按关键词搜索配图。不可用/搜不到/出错时一律返回 [] */
export async function searchImages(query, count = config.image.count) {
  if (!isImageEnabled() || count <= 0) return [];

  const q = String(query || '').trim();
  if (!q) {
    logger.warn('文章未给出配图关键词（imageQuery 为空），跳过配图');
    return [];
  }

  const provider = config.image.provider;
  try {
    const photos = await withRetry(
      () => (provider === 'pexels' ? searchPexels(q, count) : searchUnsplash(q, count)),
      { retries: 1, label: `图库搜索(${provider})` }
    );
    if (photos.length === 0) {
      logger.warn(`图库没搜到配图: "${q}"`);
      return [];
    }
    logger.info(`图库命中 ${photos.length} 张配图: "${q}"（${provider}）`);
    return photos;
  } catch (err) {
    logger.warn(`图库搜索失败（不影响发布）: ${err.message}`);
    return [];
  }
}

/** 下载单张图片。失败返回 null */
export async function downloadImage(url) {
  try {
    const { default: axios } = await import('axios');
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: TIMEOUT,
      maxContentLength: MAX_IMAGE_BYTES,
      maxBodyLength: MAX_IMAGE_BYTES,
    });

    const contentType = String(res.headers?.['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (!contentType.startsWith('image/')) {
      logger.warn(`配图下载返回的不是图片（${contentType}），已跳过`);
      return null;
    }
    return { buffer: Buffer.from(res.data), contentType };
  } catch (err) {
    logger.warn(`配图下载失败: ${err.message}`);
    return null;
  }
}

/**
 * 搜索并下载最多 count 张配图。
 * 单张下载失败只跳过它，不影响其余图片。
 * @returns {Promise<Array<{buffer: Buffer, contentType: string, author: string, link: string}>>}
 */
export async function fetchImages(query, count = config.image.count) {
  const photos = await searchImages(query, count);
  if (photos.length === 0) return [];

  const out = [];
  for (const photo of photos) {
    if (out.length >= count) break;
    const image = await downloadImage(photo.url);
    if (image) out.push({ ...image, author: photo.author, link: photo.link });
  }

  if (out.length < photos.length) {
    logger.warn(`配图下载成功 ${out.length}/${photos.length} 张`);
  }
  return out;
}

/**
 * 生成配图署名。
 * Unsplash 的 API 使用条款要求署名摄影师并回链，所以这一步不是可选的；
 * Pexels 不强制，但也一并署名。
 * @returns {string} 可直接拼进正文的 HTML，无图时返回空串
 */
export function buildCreditHtml(images) {
  if (!images || images.length === 0) return '';

  const seen = new Set();
  const names = [];
  for (const img of images) {
    const name = String(img.author || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.length === 0) return '';

  const source = config.image.provider === 'pexels' ? 'Pexels' : 'Unsplash';
  return (
    `<p style="margin: 24px 0 0; font-size: 13px; color: #999; text-align: right;">` +
    `配图来自 ${source}｜摄影：${names.join('、')}</p>`
  );
}

// ===== provider 实现 =====

async function searchUnsplash(query, count) {
  const { default: axios } = await import('axios');
  const { data } = await axios.get(`${config.image.unsplashApiBase}/search/photos`, {
    params: {
      query,
      per_page: Math.min(count, 30),
      orientation: 'landscape',
      content_filter: 'high', // 过滤不适宜内容
    },
    headers: { Authorization: `Client-ID ${config.image.unsplashKey}` },
    timeout: TIMEOUT,
  });

  return (data?.results || [])
    .map((r) => ({
      url: r?.urls?.regular || r?.urls?.small,
      width: r?.width || 0,
      height: r?.height || 0,
      author: r?.user?.name || r?.user?.username || '',
      link: r?.links?.html || '',
    }))
    .filter((p) => p.url)
    .slice(0, count);
}

async function searchPexels(query, count) {
  const { default: axios } = await import('axios');
  const { data } = await axios.get(`${config.image.pexelsApiBase}/v1/search`, {
    params: { query, per_page: Math.min(count, 30), orientation: 'landscape' },
    headers: { Authorization: config.image.pexelsKey },
    timeout: TIMEOUT,
  });

  return (data?.photos || [])
    .map((p) => ({
      url: p?.src?.large || p?.src?.original,
      width: p?.width || 0,
      height: p?.height || 0,
      author: p?.photographer || '',
      link: p?.url || '',
    }))
    .filter((p) => p.url)
    .slice(0, count);
}
