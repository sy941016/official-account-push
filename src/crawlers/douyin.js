/**
 * 抖音热点爬虫
 * 策略：Web API → 移动端API → 第三方公开接口备用
 *
 * 爆点识别：
 *   - label_type: 1=普通 / 2=直播 / 3=挑战赛 / 4=新晋(×1.3) / 5=爆发(×3.0)
 *   - 每条输出 viralScore（跨平台可比），供主流程排序
 */
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { topicId, formatHot, isAdTopic, computeViralScore } from '../utils/cache.js';
import { sleep } from '../utils/helpers.js';

const DOUYIN_HEADERS = {
  ...config.defaultHeaders,
  Referer: 'https://www.douyin.com/',
  Origin: 'https://www.douyin.com',
  Accept: 'application/json, text/plain, */*',
};

/**
 * 抖音 label_type → 爆点标签名
 * 参考抖音 API 实测：4=新晋上升 5=热门爆发
 */
const DOUYIN_LABEL_MAP = {
  4: '新',   // 新晋榜单
  5: '爆',   // 爆发式增长
  2: '热',   // 直播/热门
};

function douyinLabelName(labelType) {
  return DOUYIN_LABEL_MAP[labelType] || '';
}

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
      if (!title || isAdTopic(title)) return null;
      const rank = i + 1;
      const hotValue = parseInt(item.hot || '0', 10) || 0;
      const viralScore = computeViralScore(rank, topN, hotValue, '');
      return {
        id: topicId(title),
        title,
        hotValue,
        hotDisplay: formatHot(hotValue),
        viralScore,
        viralLabel: '',
        rank,
        category: '抖音热点',
        summary: `抖音热搜第${rank}位：${title}（${formatHot(hotValue)}次讨论）`,
        source: 'douyin',
      };
    }).filter(Boolean);

    logger.info(`抖音第三方API：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.error(`抖音第三方API失败: ${err.message}`);
    return [];
  }
}

function parseWordList(items, topN) {
  const total = Math.min(items.length, topN);
  return items.slice(0, topN).map((item, i) => {
    const wordItem = item.word_item || item;
    const title = (wordItem.word || '').replace(/<[^>]+>/g, '').trim();
    if (!title || isAdTopic(title)) return null;

    const rank = i + 1;
    const hotValue = wordItem.hot_value || 0;

    // 提取标签类型（label_type）→ 爆点标签名
    const labelType = wordItem.label_type || item.label_type || 0;
    const viralLabel = douyinLabelName(labelType);
    const viralScore = computeViralScore(rank, total, hotValue, viralLabel);

    const labelTag = viralLabel ? `【${viralLabel}】` : '';
    const summary = `${labelTag}抖音热搜第${rank}位：${title}（${formatHot(hotValue)}次讨论）`;

    return {
      id: topicId(title),
      title,
      hotValue,
      hotDisplay: formatHot(hotValue),
      viralScore,
      viralLabel,
      rank,
      category: '抖音热点',
      summary,
      source: 'douyin',
    };
  }).filter(Boolean);
}

