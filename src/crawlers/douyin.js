/**
 * 抖音热点爬虫
 * 策略：Web API → 移动端API → 第三方公开接口备用
 */
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { topicId, formatHot } from '../utils/cache.js';

const DOUYIN_HEADERS = {
  ...config.defaultHeaders,
  Referer: 'https://www.douyin.com/',
  Origin: 'https://www.douyin.com',
  Accept: 'application/json, text/plain, */*',
};

/**
 * 爬取抖音热点
 * @param {number} topN
 * @returns {Promise<Array>}
 */
export async function getDouyinHot(topN = 20) {
  logger.info('开始爬取抖音热点...');

  // 随机延迟，模拟真实访问
  await sleep(1000 + Math.random() * 2000);

  let topics = await fetchFromWebApi(topN);
  if (topics.length > 0) return topics;

  topics = await fetchFromMobileApi(topN);
  if (topics.length > 0) return topics;

  topics = await fetchFromTenApi(topN);
  return topics;
}

async function fetchFromWebApi(topN) {
  try {
    const headers = { ...DOUYIN_HEADERS };
    if (config.crawler.douyinCookie) headers['Cookie'] = config.crawler.douyinCookie;

    const { data } = await axios.get(config.crawler.douyinUrl, {
      params: {
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        detail_list: '1',
      },
      headers,
      timeout: 15_000,
    });

    const items = data?.data?.word_list || [];
    const results = parseWordList(items, topN);
    logger.info(`抖音Web API：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.warn(`抖音Web API失败: ${err.message}`);
    return [];
  }
}

async function fetchFromMobileApi(topN) {
  try {
    const headers = { ...DOUYIN_HEADERS };
    if (config.crawler.douyinCookie) headers['Cookie'] = config.crawler.douyinCookie;

    const { data } = await axios.get(
      'https://www.douyin.com/web/api/v2/hotsearch/billboard/word/',
      { headers, timeout: 15_000 }
    );

    const items = data?.word_list || [];
    const results = parseWordList(items, topN);
    logger.info(`抖音移动端API：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.warn(`抖音移动端API失败: ${err.message}`);
    return [];
  }
}

async function fetchFromTenApi(topN) {
  try {
    const { data } = await axios.get('https://tenapi.cn/v2/douyinhot', {
      timeout: 8_000,
      headers: config.defaultHeaders,
    });

    const items = Array.isArray(data?.data) ? data.data : [];
    const results = items.slice(0, topN).map((item, i) => {
      const title = item.name || item.title || '';
      const hotValue = parseInt(item.hot || '0', 10) || 0;
      return {
        id: topicId(title),
        title,
        hotValue,
        hotDisplay: formatHot(hotValue),
        rank: i + 1,
        category: '抖音热点',
        summary: `抖音热点第${i + 1}位：${title}（${formatHot(hotValue)}次讨论）`,
        source: 'douyin',
      };
    }).filter(t => t.title);

    logger.info(`抖音第三方API：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.error(`抖音第三方API失败: ${err.message}`);
    return [];
  }
}

function parseWordList(items, topN) {
  return items.slice(0, topN).map((item, i) => {
    const wordItem = item.word_item || item;
    const title = (wordItem.word || '').replace(/<[^>]+>/g, '').trim();
    if (!title) return null;
    const hotValue = wordItem.hot_value || 0;
    return {
      id: topicId(title),
      title,
      hotValue,
      hotDisplay: formatHot(hotValue),
      rank: i + 1,
      category: '抖音热点',
      summary: `抖音热点第${i + 1}位：${title}（${formatHot(hotValue)}次讨论）`,
      source: 'douyin',
    };
  }).filter(Boolean);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
