import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { dirname } from 'path';
import config from '../../config/index.js';

/**
 * 生成话题唯一ID（md5前12位）
 */
export function topicId(title) {
  return createHash('md5').update(title).digest('hex').slice(0, 12);
}

/**
 * 加载已处理话题ID集合
 */
export function loadProcessed() {
  if (!existsSync(config.cacheFile)) return new Set();
  try {
    const data = JSON.parse(readFileSync(config.cacheFile, 'utf-8'));
    return new Set(data.ids || []);
  } catch {
    return new Set();
  }
}

/**
 * 保存已处理话题ID（最多保留1000条）
 */
export function saveProcessed(id) {
  mkdirSync(dirname(config.cacheFile), { recursive: true });
  const set = loadProcessed();
  set.add(id);
  const ids = [...set].slice(-1000);
  writeFileSync(config.cacheFile, JSON.stringify({ ids }, null, 2), 'utf-8');
}

/**
 * 批量保存已处理话题ID（最多保留1000条）
 * @param {string[]} newIds
 */
export function saveProcessedBatch(newIds) {
  if (!newIds || newIds.length === 0) return;
  mkdirSync(dirname(config.cacheFile), { recursive: true });
  const set = loadProcessed();
  for (const id of newIds) set.add(id);
  const ids = [...set].slice(-1000);
  writeFileSync(config.cacheFile, JSON.stringify({ ids }, null, 2), 'utf-8');
}

/**
 * 过滤关键词（广告词条 / 低价值内容）
 */
const AD_KEYWORDS = [
  // 商业广告
  '广告', '限时', '折扣', '优惠券', '直播带货', '电商促销',
  '拼多多', '淘宝', '京东秒杀', '品牌推广', '种草',
  // 低价值娱乐
  '占卜', '星座运势', '求签', '转发锦鲤', '抽奖福利',
  // 明显营销
  '带货', '下单', '扫码', '领红包', '免费领取',
];

export function isAdTopic(title) {
  return AD_KEYWORDS.some((kw) => title.includes(kw));
}

/**
 * 爆点标签 → 权重乘数
 * 微博标签：爆/沸/热/新/荐
 * 抖音标签：爆/热/新
 */
const LABEL_MULTIPLIER = {
  '爆': 3.0,  // 全网引爆
  '沸': 2.5,  // 微博极热
  '热': 1.5,  // 正在升温
  '新': 1.3,  // 新晋上榜
  '荐': 1.1,  // 官方推荐
};

export function getLabelMultiplier(labelName = '') {
  return LABEL_MULTIPLIER[labelName] || 1.0;
}

/**
 * 计算跨平台爆点得分
 * 基于排名归一化 + 热度对数补偿 + 标签加权
 * 确保不同平台（微博/抖音）可以公平比较
 *
 * @param {number} rank        排名（1 最热）
 * @param {number} topN        该平台总数
 * @param {number} hotValue    平台原始热度值
 * @param {string} labelName   爆点标签（爆/沸/热/新）
 * @returns {number}
 */
export function computeViralScore(rank, topN, hotValue = 0, labelName = '') {
  // 排名得分：第1名=100，最后=~3（归一化，跨平台公平）
  const rankScore = ((topN - rank + 1) / topN) * 100;
  // 热度补偿：对数压缩，限制在 0~30，避免平台数量级差异主导
  const hotBonus = hotValue > 0 ? Math.min(30, Math.log10(hotValue + 1) * 5) : 0;
  const multiplier = getLabelMultiplier(labelName);
  return Math.round((rankScore + hotBonus) * multiplier);
}

/**
 * 提取关键词（用于配图搜索）
 */
export function extractKeywords(title) {
  const stopwords = new Set(['的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
    '都', '一', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着']);
  return title.match(/[\u4e00-\u9fa5A-Za-z0-9]+/g)
    ?.filter(w => !stopwords.has(w) && w.length >= 2)
    .slice(0, 5) || [];
}

/**
 * 中文话题标题 → 英文搜索词（简单映射，建议接翻译API）
 */
const CN_EN_MAP = {
  科技: 'technology', 经济: 'economy', 政治: 'politics', 体育: 'sports',
  娱乐: 'entertainment', 教育: 'education', 健康: 'health', 美食: 'food',
  旅游: 'travel', 时尚: 'fashion', 社会: 'society', 国际: 'international',
  明星: 'celebrity', 电影: 'movie', 音乐: 'music', 汽车: 'automobile',
  人工智能: 'artificial intelligence', 房产: 'real estate', 股市: 'stock market',
  战争: 'war', 环境: 'environment', 医疗: 'medical',
};

export function toEnglishQuery(title) {
  for (const [cn, en] of Object.entries(CN_EN_MAP)) {
    if (title.includes(cn)) return en;
  }
  return 'news trending';
}

/**
 * 格式化热度数值
 */
export function formatHot(value) {
  if (!value) return '0';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
  return String(value);
}
