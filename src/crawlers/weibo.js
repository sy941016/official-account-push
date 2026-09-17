/**
 * 微博热搜爬虫
 * 策略：官方Ajax API → 第三方公开接口备用 → 网页解析兜底
 *
 * 爆点识别：
 *   - 提取微博官方标签：爆(×3.0) / 沸(×2.5) / 热(×1.5) / 新(×1.3)
 *   - 每条输出 viralScore（跨平台可比），供主流程排序
 */
import axios from 'axios';
import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { topicId, isAdTopic, computeViralScore, formatHot } from '../utils/cache.js';

const BASE_HEADERS = {
  ...config.defaultHeaders,
  Referer: 'https://weibo.com/',
};

const TIMEOUT = config.crawler.requestTimeoutMs;

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
      timeout: TIMEOUT,
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

      // 构造摘要。
      // 注意：微博官方接口的 note 字段实测**就是标题本身**——连测 51 条，51/51 与 word
      // 逐字相同（早前以为的"【新】前缀"其实是 label_name，不是 note 的内容）。
      // 原先"有 note 就用 note"的做法，会让提示词里的【背景】变成和【标题】一模一样的
      // 字符串——模型等于在零背景信息下写作，只能靠猜。
      // 所以只在 note 确实超出标题时才采用它；否则退回热度。热度是真正不重复的信息，
      // 而排名已经在提示词的"来源"行里了，不必再写一遍。
      const labelTag = viralLabel ? `【${viralLabel}】` : '';
      const noteText = item.note ? stripHtml(item.note) : '';
      // 比较前先剥掉前导的【沸】【热】标签，否则 "【沸】<标题>" 会被判成"有新信息"，
      // 摘要仍然只是标题加个前缀——正是要修的那个毛病。
      const noteCore = stripLeadingLabels(noteText);
      const noteAddsInfo = Boolean(noteCore) && noteCore !== title && !title.includes(noteCore);
      const summary = noteAddsInfo ? `${labelTag}${noteText}` : `${labelTag}热度 ${formatHot(hotValue)}`;

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
      timeout: TIMEOUT,
      headers: config.defaultHeaders,
    });

    // tenapi 返回格式：{ code: 200, data: [{name, hot, url}] }
    const items = (Array.isArray(data?.data) ? data.data : [])
      .map((item) => ({ title: item.name || item.title || '', hot: item.hot }))
      .filter((item) => item.title && !isAdTopic(item.title))
      .slice(0, topN);

    const results = items.map((item, i) => {
      const rank = i + 1;
      const hotValue = parseInt(item.hot || '0', 10) || 0;
      const viralScore = computeViralScore(rank, items.length, hotValue, '');
      return normalize({
        title: item.title,
        hotValue,
        viralScore,
        viralLabel: '',
        rank,
        category: '社会',
        // 第三方接口只有标题和热度，没有背景。别把标题再抄进"背景"里
        // （排名提示词里已经有），只留热度这个真正新增的数字。
        summary: `热度 ${formatHot(hotValue)}`,
        source: 'weibo',
      });
    });

    logger.info(`微博第三方API：获取 ${results.length} 条`);
    return results;
  } catch (err) {
    logger.warn(`微博第三方API失败: ${err.message}`);
    return [];
  }
}

async function fetchFromWebpage(topN) {
  try {
    // cheerio 是个重量级依赖，而这里只是三级兜底策略，按需加载即可
    const cheerio = await import('cheerio');

    const headers = { ...BASE_HEADERS };
    if (config.crawler.weiboCookie) headers['Cookie'] = config.crawler.weiboCookie;

    const { data: html } = await axios.get(config.crawler.weiboBackupUrl, {
      headers,
      timeout: TIMEOUT,
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
        // 网页兜底只有标题，拿不到热度也没有 note —— 干脆不给背景。
        // 给空字符串，由提示词模板决定整行不输出（见 generator.js 的 backgroundLine）。
        summary: '',
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

function stripHtml(str) {
  return String(str).replace(/<[^>]+>/g, '').trim();
}

/**
 * 微博常在 note 前面重复一遍标题并加上【沸】【热】【新】之类的标签。
 * 判断"这条 note 有没有带来新信息"之前，要先把这层装饰剥掉，
 * 否则 "【沸】某地突发暴雨" 会被当成新内容，而它其实只是标题加了前缀。
 */
function stripLeadingLabels(text) {
  return String(text).replace(/^(\s*【[^】]{1,4}】\s*)+/, '').trim();
}
