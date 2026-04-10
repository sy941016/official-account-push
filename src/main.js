/**
 * 主程序入口
 *
 * 运行模式（--mode=xxx）：
 *   once       只执行一次（默认）
 *   scheduler  只启动定时任务
 *   websocket  定时任务 + 飞书 WebSocket 长连接（推荐，无需公网IP）
 *   server     定时任务 + 飞书本地 HTTP 回调服务（需内网穿透）
 *
 * 其他参数：
 *   --source=weibo|douyin|all（默认 all）
 *   --topics=N  本次处理数量
 *
 * 示例：
 *   node src/main.js --mode=websocket
 *   node src/main.js --mode=once --source=weibo --topics=1
 */

import cron from 'node-cron';
import config from '../config/index.js';
import logger from './utils/logger.js';
import { loadProcessed, saveProcessedBatch } from './utils/cache.js';
import { generateArticle } from './ai/generator.js';
import { publishToDraft } from './wechat/publisher.js';
import * as feishu from './feishu/app.js';
import { sleep } from './utils/helpers.js';

// ===== 运行状态 =====
const stats = {
  todayCount: 0,
  totalCount: 0,
  lastRun: null,
  nextRun: null,
  aiProvider: config.ai.provider,
  imageProvider: config.image.provider,
  cronSchedule: config.run.cronSchedule,
  startTime: new Date().toLocaleString('zh-CN'),
};

export const getStats = () => ({ ...stats });

// 缓存最近一次爬取的热点
let _cachedTopics = [];

// ===== 主流程 =====
/**
 * @param {string[]} sources  ['weibo','douyin']
 * @param {number}   maxTopics
 * @returns {Promise<{success: number, total: number, message?: string}>}
 */
export async function runPipeline(sources = ['weibo', 'douyin'], maxTopics = config.run.topicsPerRun) {
  const now = new Date().toLocaleString('zh-CN');
  logger.info('='.repeat(60));
  logger.info(`🚀 执行热点内容流程 [${now}]`);
  logger.info(`   来源: ${sources.join('+')}  处理数量: ${maxTopics}`);
  logger.info('='.repeat(60));

  stats.lastRun = now;

  // ── 步骤1：爬取热点 ──────────────────────────────────────
  const allTopics = await fetchTopics(sources);
  if (allTopics.length === 0) {
    logger.warn('未获取到任何热点，跳过');
    return { success: 0, total: 0, message: '未获取到任何热点' };
  }

  // ── 步骤2：去重过滤 ──────────────────────────────────────
  const processed = loadProcessed();
  const newTopics = allTopics.filter(t => !processed.has(t.id));

  if (newTopics.length === 0) {
    logger.info('所有热点均已处理，无新内容');
    await notifyNoNew();
    return { success: 0, total: 0, message: '当前热点均已处理，无新内容' };
  }

  logger.info(`共 ${allTopics.length} 条，${newTopics.length} 条未处理，取前 ${maxTopics} 条`);
  const toProcess = newTopics.slice(0, maxTopics);

  // ── 步骤3：逐条处理 ─────────────────────────────────────
  let successCount = 0;
  const processedIds = [];
  for (let i = 0; i < toProcess.length; i++) {
    const topic = toProcess[i];
    logger.info(`\n[${i + 1}/${toProcess.length}] ${topic.title}`);

    try {
      const ok = await processTopic(topic);
      if (ok) {
        successCount++;
        processedIds.push(topic.id);
        stats.todayCount++;
        stats.totalCount++;
      }
    } catch (err) {
      logger.error(`处理话题异常: ${err.message}`);
      await notifyError(err.message, `处理话题: ${topic.title}`);
    }

    // 避免API限速
    if (i < toProcess.length - 1) {
      logger.info('等待5秒...');
      await sleep(5000);
    }
  }

  // 批量写入缓存，避免循环内多次读写
  saveProcessedBatch(processedIds);

  logger.info(`\n✅ 完成：成功 ${successCount}/${toProcess.length} 篇`);
  return { success: successCount, total: toProcess.length };
}

// ===== 爬取 =====
async function fetchTopics(sources) {
  const tasks = [];
  if (sources.includes('weibo')) {
    const { getWeiboHot } = await import('./crawlers/weibo.js');
    tasks.push(getWeiboHot(30).catch(err => { logger.error(`微博爬取异常: ${err.message}`); return []; }));
  }
  if (sources.includes('douyin')) {
    const { getDouyinHot } = await import('./crawlers/douyin.js');
    tasks.push(getDouyinHot(20).catch(err => { logger.error(`抖音爬取异常: ${err.message}`); return []; }));
  }
  const results = (await Promise.all(tasks)).flat();
  // 按 viralScore 降序（跨平台爆点评分），兜底用 hotValue
  results.sort((a, b) => (b.viralScore || 0) - (a.viralScore || 0) || (b.hotValue || 0) - (a.hotValue || 0));
  // 打印 Top5 爆点预览
  const top5 = results.slice(0, 5).map((t, i) =>
    `  #${i + 1} [${t.source}]${t.viralLabel ? `【${t.viralLabel}】` : ''} ${t.title} (score:${t.viralScore || 0})`
  ).join('\n');
  logger.info(`爆点 Top5 预览:\n${top5}`);
  // 缓存热点供后续使用
  _cachedTopics = results;
  return results;
}

// ===== 单条处理 =====
async function processTopic(topic) {
  // 1. 生成文章
  logger.info('  📝 AI生成文章...');
  const article = await generateArticle(topic);
  if (!article) { logger.error('  ❌ 文章生成失败'); return false; }
  logger.info(`  ✓ 标题: ${article.title}`);



  // 3. 推送草稿
  let draftId = null;
  if (config.wechat.appId) {
    logger.info('  📤 推送至微信草稿箱...');
    try {
      draftId = await publishToDraft(article);
    } catch (err) {
      logger.error(`  微信推送异常: ${err.message}`);
    }
  } else {
    logger.warn('  微信公众号未配置，跳过');
  }

  // 4. 飞书通知
  if (config.feishu.appId) {
    logger.info('  🤖 发送飞书通知...');
    try {
      await feishu.sendArticleCard({
        topicTitle: topic.title,
        articleTitle: article.title,
        digest: article.digest,
        source: topic.source,
        rank: topic.rank,
        draftId,
        style: config.articleStyle?.style || 'default',
      });
      logger.info('  ✓ 飞书通知已发送');
    } catch (err) {
      logger.error(`  飞书通知异常: ${err.message}`);
    }
  } else {
    logger.warn('  飞书未配置，跳过');
  }

  return true;
}

// ===== 通知辅助 =====
async function notifyNoNew() {
  if (!config.feishu.appId) return;
  feishu.sendText('ℹ️ 本次检查：当前热点均已处理，无新内容生成。').catch(() => {});
}

async function notifyError(msg, step) {
  if (!config.feishu.appId) return;
  feishu.sendErrorAlert(msg, step).catch(() => {});
}

// ===== 周杰伦歌曲模式 - 直接生成情感文章（不依赖热点）=====
/**
 * 生成周杰伦风格的情感文章，不依赖热点话题
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function generateJayChouArticle() {
  const now = new Date().toLocaleString('zh-CN');
  logger.info('='.repeat(60));
  logger.info(`🚀 生成周杰伦风格情感文章 [${now}]`);
  logger.info('='.repeat(60));

  stats.lastRun = now;

  // 构建一个虚拟话题对象，用于生成文章
  // 周杰伦模式不依赖真实热点，而是让AI自由发挥创作情感文章
  const virtualTopic = {
    id: `jaychou_${Date.now()}`,
    title: '周杰伦风格情感文章',
    summary: '以周杰伦音乐为灵感，创作一篇关于青春、爱情、回忆或成长的情感文章',
    source: 'jaychou',
    rank: 1,
    hotValue: 0,
    viralScore: 0,
  };

  try {
    const ok = await processTopic(virtualTopic);
    if (ok) {
      stats.todayCount++;
      stats.totalCount++;
      logger.info('\n✅ 周杰伦风格文章生成完成');
      return { success: true };
    } else {
      return { success: false, message: '文章生成失败' };
    }
  } catch (err) {
    logger.error(`生成文章异常: ${err.message}`);
    return { success: false, message: err.message };
  }
}

// ===== 按当前模式生成文章（使用已缓存的热点）=====
/**
 * 使用缓存的热点，按当前模式生成文章
 * @param {number} maxTopics 处理数量
 * @returns {Promise<{success: number, total: number, message?: string}>}
 */
export async function generateWithCurrentMode(maxTopics = config.run.topicsPerRun) {
  const now = new Date().toLocaleString('zh-CN');
  const currentStyle = config.articleStyle?.style || 'default';
  const styleName = currentStyle === 'jaychou' ? '🎵 周杰伦歌曲' : '📰 默认模式';

  logger.info('='.repeat(60));
  logger.info(`🚀 按当前模式生成文章 [${now}]`);
  logger.info(`   模式: ${styleName} | 处理数量: ${maxTopics}`);
  logger.info('='.repeat(60));

  // 检查是否有缓存的热点
  if (_cachedTopics.length === 0) {
    logger.warn('暂无缓存的热点，请先等待定时任务抓取或发送 /fetch 抓取新热点');
    return { success: 0, total: 0, message: '暂无缓存的热点，请先抓取热点' };
  }

  stats.lastRun = now;

  // 去重过滤
  const processed = loadProcessed();
  const newTopics = _cachedTopics.filter(t => !processed.has(t.id));

  if (newTopics.length === 0) {
    logger.info('所有热点均已处理，无新内容');
    return { success: 0, total: 0, message: '所有热点均已处理，无新内容' };
  }

  logger.info(`缓存共 ${_cachedTopics.length} 条，${newTopics.length} 条未处理，取前 ${maxTopics} 条`);
  const toProcess = newTopics.slice(0, maxTopics);

  // 逐条处理
  let successCount = 0;
  const processedIds = [];
  for (let i = 0; i < toProcess.length; i++) {
    const topic = toProcess[i];
    logger.info(`\n[${i + 1}/${toProcess.length}] ${topic.title}`);

    try {
      const ok = await processTopic(topic);
      if (ok) {
        successCount++;
        processedIds.push(topic.id);
        stats.todayCount++;
        stats.totalCount++;
      }
    } catch (err) {
      logger.error(`处理话题异常: ${err.message}`);
    }

    // 避免API限速
    if (i < toProcess.length - 1) {
      logger.info('等待5秒...');
      await sleep(5000);
    }
  }

  // 批量写入缓存
  saveProcessedBatch(processedIds);

  logger.info(`\n✅ 完成：成功 ${successCount}/${toProcess.length} 篇`);
  return { success: successCount, total: toProcess.length };
}

// 导出周杰伦文章生成函数供WebSocket使用
export { generateJayChouArticle };

// ===== 定时任务 =====
function startScheduler(sources, cronExpression) {
  if (!cron.validate(cronExpression)) {
    logger.error(`Cron表达式无效: ${cronExpression}`);
    return;
  }
  logger.info(`⏰ 定时任务已启动: ${cronExpression}`);

  const task = cron.schedule(cronExpression, async () => {
    logger.info('⏰ 定时任务触发');
    await runPipeline(sources).catch(err =>
      logger.error(`定时任务异常: ${err.message}`)
    );
  });

  // 粗略估算下次执行时间（仅提示用）
  stats.nextRun = `按 [${cronExpression}] 执行`;
  return task;
}

// ===== CLI 入口 =====
async function main() {
  // 解析命令行参数
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter(a => a.startsWith('--'))
      .map(a => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; })
  );

  const mode = args.mode || 'once';
  const sourceArg = args.source || 'all';
  const sources = sourceArg === 'all' ? ['weibo', 'douyin'] : [sourceArg];
  const maxTopics = args.topics ? parseInt(args.topics, 10) : undefined;

  logger.info('🤖 热点内容自动化发布系统');
  logger.info(`   模式: ${mode} | 来源: ${sources.join('+')} | AI: ${config.ai.provider}`);
  logger.info(`   微信: ${config.wechat.appId ? '✅ 已配置' : '❌ 未配置'}`);
  logger.info(`   飞书: ${config.feishu.appId ? '✅ 已配置' : '❌ 未配置'}`);

  const pipeline = () => runPipeline(sources, maxTopics);

  switch (mode) {
    case 'once':
      await pipeline();
      break;

    case 'scheduler':
      startScheduler(sources, config.run.cronSchedule);
      break;

    case 'websocket': {
      // 定时任务在子线程跑（不阻塞主线程）
      startScheduler(sources, config.run.cronSchedule);
      // 主进程跑飞书WebSocket
      const ws = await import('./feishu/websocket.js');
      ws.init(pipeline, getStats, generateWithCurrentMode, generateJayChouArticle);
      // 启动 WebSocket（不自动执行，等待用户指令或定时任务）
      ws.startWebSocket();
      break;
    }

    case 'server': {
      startScheduler(sources, config.run.cronSchedule);
      const srv = await import('./feishu/server.js');
      srv.init(pipeline, getStats);
      srv.startLocalServer();
      break;
    }

    default:
      logger.error(`未知模式: ${mode}，可选: once | scheduler | websocket | server`);
      process.exit(1);
  }
}

main().catch(err => {
  logger.error(`启动失败: ${err.message}`);
  process.exit(1);
});
