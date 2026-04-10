/**
 * 日志模块
 *
 * 相对旧实现的改动：
 * 1. 缓冲 + 批量落盘，替代"每行一次 appendFileSync" —— 之前每写一行日志都会同步阻塞事件循环
 * 2. 按大小轮转 + 保留 N 份 —— 之前单日日志可以无限增长（仓库里已出现 1MB+ 的日志文件）
 * 3. 日志目录锚定到项目根目录 —— 之前用相对路径 "logs"，换个目录启动就写丢了
 * 4. 写盘失败时降级到控制台，不再抛错打断主流程
 *
 * 关于落盘方式：这里没有用 fs.createWriteStream。可写流的 open 是异步的，
 * 在"短时间内连写很多行"（事件循环还没转）的场景下文件尚未创建，按大小轮转时
 * rename 会静默失效，日志又会无限增长。改为内存缓冲 + appendFileSync 批量落盘后，
 * 文件大小与轮转时机都是确定的。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import config from '../../config/index.js';

const LOG_DIR = config.log.dir;
mkdirSync(LOG_DIR, { recursive: true });

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const LEVEL_INDEX = Math.max(0, LOG_LEVELS.indexOf(config.log.level));

/** 缓冲区达到该字节数就立即落盘，避免长时间不 flush 时内存堆积。
 *  不能超过单文件上限，否则一次 flush 就会把文件写超（小上限场景下尤其明显）。 */
const FLUSH_THRESHOLD_BYTES = Math.max(1, Math.min(16 * 1024, config.log.maxSizeBytes));
/** 定期落盘间隔，保证日志"最终会"写到文件 */
const FLUSH_INTERVAL_MS = 1000;

let _buffer = [];
let _bufferBytes = 0;
let _fileDate = '';
let _fileSize = 0;
let _flushTimer = null;

const pad2 = (n) => String(n).padStart(2, '0');

/** 本地日期（YYYY-MM-DD）。
 *  这里不能用 toISOString() —— 它返回 UTC。在 UTC+8 下日志文件名会提前 8 小时换天，
 *  本地 00:00~08:00 写的日志会被归档进前一天的日期，跟控制台/统计口径也对不上。 */
const localDateKey = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 本地时间戳（YYYY-MM-DD HH:mm:ss），与日志文件名、startTime 保持同一时区口径 */
const localTimestamp = (d = new Date()) =>
  `${localDateKey(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

const dateKey = () => localDateKey();
const currentFile = () => join(LOG_DIR, `${_fileDate}.log`);

function ensureFileState() {
  const today = dateKey();
  if (today === _fileDate) return;

  // 跨天：先把上一天缓冲区落盘，再切到新文件
  flushBuffer();
  _fileDate = today;
  const file = currentFile();
  _fileSize = existsSync(file) ? statSync(file).size : 0;
}

/** 生成不冲突的归档文件名（重启后继续递增，不会覆盖旧归档） */
function nextArchivePath() {
  const prefix = `${_fileDate}.`;
  let maxIndex = 0;
  try {
    for (const f of readdirSync(LOG_DIR)) {
      const m = f.match(new RegExp(`^${_fileDate}\\.(\\d+)\\.log$`));
      if (m) maxIndex = Math.max(maxIndex, Number(m[1]));
    }
  } catch {
    /* 目录读取失败时退化为从 1 开始 */
  }
  return join(LOG_DIR, `${prefix}${maxIndex + 1}.log`);
}

/** 只保留最近 maxFiles 份日志（按修改时间排序，最旧的先删） */
function pruneOldFiles() {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(f))
      .map((f) => ({ f, mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);

    for (let i = 0; i < files.length - config.log.maxFiles; i++) {
      unlinkSync(join(LOG_DIR, files[i].f));
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/** 当前文件超过上限时归档并重开 */
function rotateIfNeeded() {
  if (_fileSize < config.log.maxSizeBytes) return;
  const base = currentFile();
  try {
    if (existsSync(base)) renameSync(base, nextArchivePath());
  } catch (err) {
    console.error(`[logger] 日志轮转失败: ${err.message}`);
  }
  _fileSize = 0;
  pruneOldFiles();
}

/** 把缓冲区写入文件（同步，保证落盘顺序与轮转判断准确） */
function flushBuffer() {
  if (_buffer.length === 0) return;

  const payload = `${_buffer.join('\n')}\n`;
  const bytes = Buffer.byteLength(payload);
  _buffer = [];
  _bufferBytes = 0;

  try {
    ensureFileState();
    appendFileSync(currentFile(), payload);
    _fileSize += bytes;
    rotateIfNeeded();
  } catch (err) {
    console.error(`[logger] 日志写入失败: ${err.message}`);
  }
}

function scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    if (_buffer.length === 0) return;
    try {
      flushBuffer();
    } catch {
      /* flushBuffer 内部已处理异常 */
    }
  }, FLUSH_INTERVAL_MS);
  // 不要让定时器把进程吊住
  _flushTimer.unref?.();
}

function writeLine(line) {
  _buffer.push(line);
  _bufferBytes += Buffer.byteLength(line) + 1;

  if (_bufferBytes >= FLUSH_THRESHOLD_BYTES) {
    flushBuffer();
    return;
  }
  scheduleFlush();
}

// ===== 对外 API =====
function log(level, message, meta = {}) {
  if (LOG_LEVELS.indexOf(level) < LEVEL_INDEX) return;

  const timestamp = localTimestamp();
  const metaStr = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;

  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleMethod(line);

  try {
    writeLine(line);
  } catch (err) {
    console.error('日志文件写入失败:', err.message);
  }
}

/** 进程退出前把缓冲区刷盘 */
export function flushLogs() {
  try {
    flushBuffer();
  } catch {
    /* 退出路径上不再抛错 */
  }
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  return Promise.resolve();
}

export const logger = {
  debug: (message, meta) => log('debug', message, meta),
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};

export default logger;
