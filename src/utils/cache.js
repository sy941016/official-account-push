import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { dirname } from 'path';
import config from '../../config/index.js';
import logger from './logger.js';

/** 已处理话题 ID 的保留上限 */
const MAX_PROCESSED = 1000;

/**
 * 生成话题唯一ID（md5前12位）
 * @param {string} title
 * @returns {string}
 */
export function topicId(title) {
  return createHash('md5').update(String(title)).digest('hex').slice(0, 12);
}

/**
 * 加载已处理话题ID集合
 * @returns {Set<string>}
 */
export function loadProcessed() {
  if (!existsSync(config.cacheFile)) return new Set();
  try {
    const data = JSON.parse(readFileSync(config.cacheFile, 'utf-8'));
    const ids = Array.isArray(data?.ids) ? data.ids : [];
    return new Set(ids.slice(-MAX_PROCESSED));
  } catch {
    return new Set();
  }
}

/**
 * 批量保存已处理话题ID（最多保留 MAX_PROCESSED 条）
 * 先写临时文件再 rename，避免进程被杀时留下半个 JSON 文件
 * @param {string[]} newIds
 */
export function saveProcessedBatch(newIds) {
  if (!newIds || newIds.length === 0) return;
  try {
    mkdirSync(dirname(config.cacheFile), { recursive: true });
    const set = loadProcessed();
    for (const id of newIds) set.add(id);
    const ids = [...set].slice(-MAX_PROCESSED);

    const tmpFile = `${config.cacheFile}.tmp`;
    writeFileSync(tmpFile, JSON.stringify({ ids }, null, 2), 'utf-8');
    renameSync(tmpFile, config.cacheFile);
  } catch (err) {
    logger.error(`写入已处理缓存失败: ${err.message}`);
  }
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
  return AD_KEYWORDS.some((kw) => String(title).includes(kw));
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
  const safeTopN = Math.max(1, topN);
  // 排名得分：第1名=100，最后=~3（归一化，跨平台公平）
  const rankScore = ((safeTopN - rank + 1) / safeTopN) * 100;
  // 热度补偿：对数压缩，限制在 0~30，避免平台数量级差异主导
  const hotBonus = hotValue > 0 ? Math.min(30, Math.log10(hotValue + 1) * 5) : 0;
  const multiplier = getLabelMultiplier(labelName);
  return Math.round((rankScore + hotBonus) * multiplier);
}

/**
 * 格式化热度数值
 * @param {number} value
 * @returns {string}
 */
export function formatHot(value) {
  if (!value) return '0';
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}亿`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)}万`;
  return String(value);
}
