/**
 * 微博热搜爬虫
 * 策略：官方Ajax API → 第三方公开接口备用 → 网页解析兜底
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { topicId, isAdTopic } from '../utils/cache.js';

const BASE_HEADERS = {
  ...config.defaultHeaders,
  Referer: 'https://weibo.com/',
};

/**
 * 爬取微博热搜，返回标准化数组
 * @param {number} topN
 * @returns {Promise<Array>}
 */
export async function getWeiboHot(topN = 30) {
  logger.info('开始爬取微博热搜...');

  // 方法1：微博官方 Ajax 接口
  let topics = await fetchFromOfficialApi(topN);
  if (topics.length > 0) return topics;

  // 方法2：第三方公开接口（tenapi）
  topics = await fetchFromTenApi(topN);
  if (topics.length > 0) return topics;

  // 方法3：网页解析兜底
  topics = await fetchFromWebpage(topN);
  return topics;
}

async function fetchFromOfficialApi(topN) {
  try {
    const headers = { ...BASE_HEADERS };
    if (config.crawler.weiboCookie) {
      headers['Cookie'] = config.crawler.weiboCookie;
    }

    const { data } = await axios.get(config.crawler.weiboUrl, {
      headers,
      timeout: 10_000,
    });

    const items = data?.data?.realtime || [];
    const results = [];
    let rank = 0;

    for (const item of items) {
      if (rank >= topN) break;
      if (['广告', '商业热点'].includes(item.label_name)) continue;

      const title = stripHtml(item.word || '');
      if (!title || isAdTopic(title)) continue;

      rank++;
      results.push(normalize({
        title,
        hotValue: item.num || 0,
        rank,
        category: item.category || '社会',
        summary: item.note || `微博热搜第${rank}位：${title}`,
        source: 'weibo',
      }));
    }

    logger.info(`微博官方API：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.warn(`微博官方API失败: ${err.message}`);
    return [];
  }
}

async function fetchFromTenApi(topN) {
  try {
    const { data } = await axios.get(config.crawler.weiboFallbackUrl, {
      timeout: 8_000,
      headers: config.defaultHeaders,
    });

    // tenapi 返回格式：{ code: 200, data: [{name, hot, url}] }
    const items = Array.isArray(data?.data) ? data.data : [];
    const results = items.slice(0, topN).map((item, i) => {
      const title = item.name || item.title || '';
      return normalize({
        title,
        hotValue: parseInt(item.hot || '0', 10) || 0,
        rank: i + 1,
        category: '社会',
        summary: `微博热搜第${i + 1}位：${title}`,
        source: 'weibo',
      });
    }).filter(t => t.title);

    logger.info(`微博第三方API：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.warn(`微博第三方API失败: ${err.message}`);
    return [];
  }
}

async function fetchFromWebpage(topN) {
  try {
    const headers = { ...BASE_HEADERS };
    if (config.crawler.weiboCookie) headers['Cookie'] = config.crawler.weiboCookie;

    const { data: html } = await axios.get(config.crawler.weiboBackupUrl, {
      headers,
      timeout: 12_000,
    });

    const $ = cheerio.load(html);
    const results = [];
    let rank = 0;

    $('td.td-02 a').each((_, el) => {
      if (rank >= topN) return false;
      const title = $(el).text().trim();
      if (!title || isAdTopic(title)) return;
      rank++;
      results.push(normalize({
        title,
        hotValue: 0,
        rank,
        category: '社会',
        summary: `微博热搜第${rank}位：${title}`,
        source: 'weibo',
      }));
    });

    logger.info(`微博网页解析：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.error(`微博网页解析失败: ${err.message}`);
    return [];
  }
}

function normalize({ title, hotValue, rank, category, summary, source }) {
  return {
    id: topicId(title),
    title,
    hotValue,
    rank,
    category,
    summary,
    source,
  };
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').trim();
}
