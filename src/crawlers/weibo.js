/**
 * 微博热搜爬虫
 * 策略：官方Ajax API → 第三方公开接口备用 → 网页解析兜底
 *
 * 爆点识别：
 *   - 提取微博官方标签：爆(×3.0) / 沸(×2.5) / 热(×1.5) / 新(×1.3)
 *   - 每条输出 viralScore（跨平台可比），供主流程排序
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { topicId, isAdTopic, computeViralScore } from '../utils/cache.js';

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

// 微博爆点标签（非广告标签）
const WEIBO_VIRAL_LABELS = new Set(['爆', '沸', '热', '新', '荐']);
// 需要跳过的商业标签
const WEIBO_AD_LABELS = new Set(['广告', '商业热点', '电视剧', '综艺', '电影']);

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
      if (WEIBO_AD_LABELS.has(item.label_name)) continue;

      const title = stripHtml(item.word || '');
      if (!title || isAdTopic(title)) continue;

      rank++;

      // 提取爆点标签：label_name / icon_desc / flag
      const rawLabel = item.label_name || item.icon_desc || '';
      const viralLabel = WEIBO_VIRAL_LABELS.has(rawLabel) ? rawLabel : '';

      const hotValue = item.num || item.raw_hot || 0;
      const viralScore = computeViralScore(rank, topN, hotValue, viralLabel);

      // 构造更丰富的摘要
      const labelTag = viralLabel ? `【${viralLabel}】` : '';
      const noteText = item.note ? item.note.replace(/<[^>]+>/g, '').trim() : '';
      const summary = noteText
        ? `${labelTag}${noteText}`
        : `${labelTag}微博热搜第${rank}位：${title}（热度${formatHotShort(hotValue)}）`;

      results.push(normalize({
        title,
        hotValue,
        viralScore,
        viralLabel,
        rank,
        category: item.category || '社会',
        summary,
        source: 'weibo',
      }));
    }

    logger.info(`微博官方API：获取 ${results.length} 条（含爆点标签）`);
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
      if (!title || isAdTopic(title)) return null;
      const rank = i + 1;
      const hotValue = parseInt(item.hot || '0', 10) || 0;
      const viralScore = computeViralScore(rank, topN, hotValue, '');
      return normalize({
        title,
        hotValue,
        viralScore,
        viralLabel: '',
        rank,
        category: '社会',
        summary: `微博热搜第${rank}位：${title}（热度${formatHotShort(hotValue)}）`,
        source: 'weibo',
      });
    }).filter(Boolean);

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
      const viralScore = computeViralScore(rank, topN, 0, '');
      results.push(normalize({
        title,
        hotValue: 0,
        viralScore,
        viralLabel: '',
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

function normalize({ title, hotValue, viralScore = 0, viralLabel = '', rank, category, summary, source }) {
  return {
    id: topicId(title),
    title,
    hotValue,
    viralScore,
    viralLabel,
    rank,
    category,
    summary,
    source,
  };
}

/** 格式化热度为短文本（用于 summary） */
function formatHotShort(value) {
  if (!value) return '未知';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(0)}万`;
  return String(value);
}

function stripHtml(str) {
  return str.replace(/<[^>]+>/g, '').trim();
}
