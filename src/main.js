/**
 * 主程序入口 - AI Agent 模式
 *
 * 运行模式（--mode=xxx）：
 *   once       只执行一次（默认，兼容旧流水线）
 *   scheduler  只启动定时任务
 *   websocket  定时任务 + 飞书 WebSocket + Web 聊天（推荐）
 *   server     定时任务 + 飞书 HTTP 回调 + Web 聊天
 *   web        仅启动 Web 聊天服务
 *
 * 其他参数：
 *   --source=weibo|douyin|all（默认 all）
 *   --topics=N  本次处理数量
 *
 * 示例：
 *   node src/main.js --mode=websocket
 *   node src/main.js --mode=web
 *   node src/main.js --mode=once --source=weibo --topics=1
 *   node src/main.js --mode=once --dry-run          # 试运行：只生成文章，不推送、不通知
 */

import { realpathSync } from 'fs';
import { pathToFileURL } from 'url';
import config, { validateConfig } from '../config/index.js';
import logger, { flushLogs } from './utils/logger.js';
import { loadProcessed, saveProcessedBatch } from './utils/cache.js';
import { dedupeBy, localDateKey, sleep } from './utils/helpers.js';
import agent from './agent/core.js';

// ===== 按需加载的重依赖 =====
// cron / 文章生成 / 公众号推送 / 飞书 只在真正跑流水线时才需要。
// 静态 import 会让 --mode=web 这种纯聊天模式也把 axios 等一大串依赖加载进来，
// 拖慢启动。这里统一改成首次使用时再加载。
let _cron = null;
const getCron = async () => (_cron ??= (await import('node-cron')).default);

let _generator = null;
const getGenerator = async () => (_generator ??= await import('./ai/generator.js'));

let _publisher = null;
const getPublisher = async () => (_publisher ??= await import('./wechat/publisher.js'));

let _feishu = null;
const getFeishu = async () => (_feishu ??= await import('./feishu/app.js'));

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

/** todayCount 是按自然日统计的，跨天必须归零，否则"今日发布"会一直累加 */
let _statsDate = localDateKey();

function rolloverStatsIfNeeded() {
  const today = localDateKey();
  if (today !== _statsDate) {
    logger.info(`跨天，今日发布计数归零（${_statsDate} → ${today}）`);
    _statsDate = today;
    stats.todayCount = 0;
  }
}

export const getStats = () => {
  rolloverStatsIfNeeded();
  return { ...stats };
};

// 缓存最近一次爬取的热点
let _cachedTopics = [];

// ===== 生命周期资源（用于优雅退出）=====
const resources = { cronTasks: [], servers: [] };
let _shuttingDown = false;

// ===== 初始化 Agent =====
function initAgent() {
  agent.init({
    stats: getStats,
    cachedTopics: _cachedTopics,
    onToolCall: (name) => {
      logger.info(`Agent工具调用: ${name}`);
    },
  });
}

// ===== 主流程（兼容旧模式）=====
/**
 * @param {string[]} sources  ['weibo','douyin']
 * @param {number}   maxTopics
 * @returns {Promise<{success: number, total: number, published: number, message?: string}>}
 */
export async function runPipeline(
  sources = ['weibo', 'douyin'],
  maxTopics = config.run.topicsPerRun,
  { dryRun = false } = {}
) {
  rolloverStatsIfNeeded();

  const now = new Date().toLocaleString('zh-CN');
  logger.info('='.repeat(60));
  logger.info(`🚀 执行热点内容流程 [${now}]`);
  logger.info(`   来源: ${sources.join('+')}  处理数量: ${maxTopics}`);
  logger.info('='.repeat(60));

  stats.lastRun = now;

  // 步骤1：爬取热点
  const allTopics = await fetchTopics(sources);
  if (allTopics.length === 0) {
    logger.warn('未获取到任何热点，跳过');
    return { success: 0, total: 0, published: 0, message: '未获取到任何热点' };
  }

  // 步骤2：去重（同一话题可能同时出现在微博和抖音，id 相同，必须在本批内先去重）
  const uniqueTopics = dedupeBy(allTopics, (t) => t.id);
  const duplicated = allTopics.length - uniqueTopics.length;
  if (duplicated > 0) logger.info(`跨平台重复话题 ${duplicated} 条，已合并`);

  // 步骤3：过滤历史已处理
  const processed = loadProcessed();
  const newTopics = uniqueTopics.filter((t) => !processed.has(t.id));

  if (newTopics.length === 0) {
    logger.info('所有热点均已处理，无新内容');
    if (!dryRun) await notifyNoNew();
    return { success: 0, total: 0, published: 0, message: '当前热点均已处理，无新内容' };
  }

  logger.info(
    `共 ${allTopics.length} 条，去重后 ${uniqueTopics.length} 条，其中 ${newTopics.length} 条未处理，取前 ${maxTopics} 条`
  );
  const toProcess = newTopics.slice(0, maxTopics);

  // 步骤4：逐条处理
  let successCount = 0;
  let publishedCount = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const topic = toProcess[i];
    logger.info(`\n[${i + 1}/${toProcess.length}] ${topic.title}`);

    try {
      const result = await processTopic(topic, { dryRun });
      if (result.generated) {
        successCount++;
        if (result.published) publishedCount++;
        if (!dryRun) {
          stats.todayCount++;
          stats.totalCount++;
          // 文章已生成就立刻登记，避免下一轮重复生成同一话题（也防进程中途被杀后重复）。
          // 试运行不能写这里，否则真跑时这些话题会被当成"已处理"而跳过。
          saveProcessedBatch([topic.id]);
        }
      }
    } catch (err) {
      logger.error(`处理话题异常: ${err.message}`);
      if (!dryRun) await notifyError(err.message, `处理话题: ${topic.title}`);
    }

    if (i < toProcess.length - 1) {
      const waitMs = config.run.topicIntervalMs;
      logger.info(`等待 ${Math.round(waitMs / 1000)} 秒...`);
      await sleep(waitMs);
    }
  }

  logger.info(
    dryRun
      ? `\n🧪 试运行完成：生成 ${successCount}/${toProcess.length} 篇（未推送、未通知）`
      : `\n✅ 完成：生成 ${successCount}/${toProcess.length} 篇，推送草稿 ${publishedCount} 篇`
  );
  return { success: successCount, total: toProcess.length, published: publishedCount, dryRun };
}

// ===== 爬取 =====
async function fetchTopics(sources) {
  const tasks = [];
  if (sources.includes('weibo')) {
    const { getWeiboHot } = await import('./crawlers/weibo.js');
    tasks.push(getWeiboHot(30).catch((err) => { logger.error(`微博爬取异常: ${err.message}`); return []; }));
  }
  if (sources.includes('douyin')) {
    const { getDouyinHot } = await import('./crawlers/douyin.js');
    tasks.push(getDouyinHot(20).catch((err) => { logger.error(`抖音爬取异常: ${err.message}`); return []; }));
  }
  const results = (await Promise.all(tasks)).flat();
  results.sort((a, b) => (b.viralScore || 0) - (a.viralScore || 0) || (b.hotValue || 0) - (a.hotValue || 0));
  _cachedTopics = results;
  // 同步到 Agent 工具层
  agent.updateCachedTopics(results);
  return results;
}

// ===== 单条处理 =====
/**
 * @param {Object} topic
 * @param {{dryRun?: boolean}} [options] dryRun=true 时只生成文章，不产生任何外部副作用
 * @returns {Promise<{generated: boolean, published: boolean}>}
 */
async function processTopic(topic, { dryRun = false } = {}) {
  logger.info('  📝 AI生成文章...');
  const { generateArticle } = await getGenerator();
  const article = await generateArticle(topic);
  if (!article) {
    logger.error('  ❌ 文章生成失败');
    return { generated: false, published: false };
  }
  logger.info(`  ✓ 标题: ${article.title}`);
  // 人味分低了说明模型这版写得还是"太 AI"，值得人工再润色一遍再发
  if (typeof article.humanScore === 'number') {
    const threshold = config.articleStyle?.minHumanScore ?? 70;
    const mark = article.humanScore >= threshold ? '✓' : '⚠️';
    logger.info(`  ${mark} 人味自检: ${article.humanScore} 分（阈值 ${threshold}）`);
  }

  // 推送草稿
  let draftId = null;
  if (dryRun) {
    logger.info('  🧪 试运行：跳过推送草稿箱');
  } else if (config.wechat.appId) {
    logger.info('  📤 推送至微信草稿箱...');
    try {
      const { publishToDraft } = await getPublisher();
      draftId = await publishToDraft(article);
      if (draftId) logger.info(`  ✓ 已进入草稿箱: ${draftId}`);
      else logger.error('  ❌ 草稿推送失败');
    } catch (err) {
      logger.error(`  微信推送异常: ${err.message}`);
    }
  } else {
    logger.warn('  微信公众号未配置，跳过');
  }

  // 飞书通知
  if (dryRun) {
    logger.info('  🧪 试运行：跳过飞书通知');
  } else if (config.feishu.appId) {
    logger.info('  🤖 发送飞书通知...');
    try {
      const feishu = await getFeishu();
      await feishu.sendArticleCard({
        topicTitle: topic.title,
        articleTitle: article.title,
        digest: article.digest,
        source: topic.source,
        rank: topic.rank,
        draftId,
        style: article.style || config.articleStyle?.style || 'default',
        humanScore: article.humanScore,
      });
      logger.info('  ✓ 飞书通知已发送');
    } catch (err) {
      logger.error(`  飞书通知异常: ${err.message}`);
    }
  }

  return { generated: true, published: Boolean(draftId) };
}

// ===== 通知辅助 =====
async function notifyNoNew() {
  if (!config.feishu.appId) return;
  const feishu = await getFeishu();
  feishu.sendText('ℹ️ 本次检查：当前热点均已处理，无新内容生成。').catch(() => {});
}

async function notifyError(msg, step) {
  if (!config.feishu.appId) return;
  const feishu = await getFeishu();
  feishu.sendErrorAlert(msg, step).catch(() => {});
}

// ===== 定时任务 =====
async function startScheduler(sources, cronExpression, { dryRun = false } = {}) {
  const cron = await getCron();

  if (!cron.validate(cronExpression)) {
    logger.error(`Cron表达式无效: ${cronExpression}，定时任务未启动`);
    return null;
  }
  logger.info(`⏰ 定时任务已启动: ${cronExpression}${dryRun ? '（试运行）' : ''}`);

  const task = cron.schedule(cronExpression, async () => {
    if (_shuttingDown) return;
    logger.info('⏰ 定时任务触发');
    await runPipeline(sources, config.run.topicsPerRun, { dryRun }).catch((err) =>
      logger.error(`定时任务异常: ${err.message}`)
    );
  });

  resources.cronTasks.push(task);
  stats.nextRun = `按 [${cronExpression}] 执行`;
  return task;
}

// ===== 优雅退出 =====
function registerShutdown() {
  const shutdown = async (signal) => {
    if (_shuttingDown) return;
    _shuttingDown = true;
    logger.info(`收到 ${signal}，正在优雅退出...`);

    for (const task of resources.cronTasks) {
      try { task.stop(); } catch { /* 忽略单个任务停止失败 */ }
    }
    await Promise.all(resources.servers.map((s) => new Promise((resolve) => s.close(resolve))));
    await flushLogs();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error(`未处理的 Promise 拒绝: ${reason instanceof Error ? reason.stack : reason}`);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`未捕获异常: ${err.stack || err.message}`);
    shutdown('uncaughtException');
  });
}

// ===== CLI 入口 =====
async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith('--'))
      .map((a) => { const [k, v = 'true'] = a.slice(2).split('='); return [k, v]; })
  );

  const mode = args.mode || 'once';
  const sourceArg = args.source || 'all';
  const sources = sourceArg === 'all' ? ['weibo', 'douyin'] : [sourceArg];
  const maxTopics = args.topics ? parseInt(args.topics, 10) : undefined;
  // 试运行：走完整的爬取 → 生成流程，但不推送草稿箱、不发飞书、不写去重缓存。
  // 用于在没有副作用的前提下验证链路是否通。
  const dryRun = args['dry-run'] === 'true' || args.dryrun === 'true';

  logger.info('🤖 AI Agent - 公众号内容助手');
  logger.info(`   模式: ${mode} | 来源: ${sources.join('+')} | AI: ${config.ai.provider}`);
  logger.info(`   微信: ${config.wechat.appId ? '✅ 已配置' : '❌ 未配置'}`);
  logger.info(`   飞书: ${config.feishu.appId ? '✅ 已配置' : '❌ 未配置'}`);
  if (dryRun) {
    logger.warn('🧪 试运行模式：只生成文章，不推送草稿箱、不发飞书通知、不记录已处理话题');
  }

  // 配置校验：错误直接退出，避免跑到一半才发现 key 没配
  const { errors, warnings } = validateConfig();
  for (const w of warnings) logger.warn(`配置提醒: ${w}`);
  if (errors.length > 0) {
    for (const e of errors) logger.error(`配置错误: ${e}`);
    logger.error('请检查 .env（可参考 .env.example）后重试');
    await flushLogs();
    process.exit(1);
  }

  registerShutdown();
  initAgent();

  switch (mode) {
    case 'once':
      await runPipeline(sources, maxTopics, { dryRun });
      await flushLogs();
      break;

    case 'scheduler':
      await startScheduler(sources, config.run.cronSchedule, { dryRun });
      break;

    case 'websocket': {
      await startScheduler(sources, config.run.cronSchedule, { dryRun });

      const ws = await import('./feishu/websocket.js');
      ws.init(agent);
      ws.startWebSocket();

      const webServer = await import('./web/server.js');
      resources.servers.push(webServer.start(agent));
      break;
    }

    case 'server': {
      await startScheduler(sources, config.run.cronSchedule, { dryRun });

      const srv = await import('./feishu/server.js');
      srv.init(agent);
      resources.servers.push(srv.startLocalServer());

      const webServer = await import('./web/server.js');
      resources.servers.push(webServer.start(agent));
      break;
    }

    case 'web': {
      const webServer = await import('./web/server.js');
      resources.servers.push(webServer.start(agent));
      break;
    }

    default:
      logger.error(`未知模式: ${mode}`);
      logger.error('可选: once | scheduler | websocket | server | web');
      process.exit(1);
  }
}

// 只有被直接执行（node src/main.js）时才启动。
// 这道守卫是必须的：没有它，任何模块只要 import 一下这个文件，就会立刻跑完整条流水线
// ——真的去调用 AI、往公众号草稿箱推文章、发飞书通知，甚至 process.exit()。
// 加上之后 runPipeline 才能被安全地复用和测试。
const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    // 用 realpath 对齐符号链接场景：ESM 的 import.meta.url 是解析后的真实路径
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch(async (err) => {
    logger.error(`启动失败: ${err.message}`);
    await flushLogs();
    process.exit(1);
  });
}
