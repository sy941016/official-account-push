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
 * 过滤关键词（广告词条）
 */
const AD_KEYWORDS = ['广告', '限时', '折扣', '优惠券', '直播带货', '电商促销'];

export function isAdTopic(title) {
  return AD_KEYWORDS.some((kw) => title.includes(kw));
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
