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

// ===== 主流程 =====
/**
 * @param {string[]} sources  ['weibo','douyin']
 * @param {number}   maxTopics
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
    return;
  }

  // ── 步骤2：去重过滤 ──────────────────────────────────────
  const processed = loadProcessed();
  const newTopics = allTopics.filter(t => !processed.has(t.id));

  if (newTopics.length === 0) {
    logger.info('所有热点均已处理，无新内容');
    await notifyNoNew();
    return;
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
      ws.init(pipeline, getStats);
      // 启动 WebSocket，连接建立后立即执行一次流程
      ws.startWebSocket().then(() => {
        pipeline().catch(err => logger.error(`首次执行异常: ${err.message}`));
      });
      break;
    }

    case 'server': {
      startScheduler(sources, config.run.cronSchedule);
      await pipeline();
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
