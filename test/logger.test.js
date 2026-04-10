import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config/index.js';
import logger, { flushLogs } from '../src/utils/logger.js';

/** 必须用本地日期：日志文件名走的是本地时区，用 toISOString() 会在 UTC+8 的
 *  00:00~08:00 之间指向错误的文件（前一天），导致测试假失败。 */
const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const todayFile = () => join(config.log.dir, `${localDate()}.log`);

test('日志目录锚定在项目根目录，与启动时的 cwd 无关', () => {
  assert.ok(config.log.dir.startsWith('/'), '日志目录应为绝对路径');
  assert.ok(existsSync(config.log.dir), '日志目录应已创建');
});

test('日志先缓冲，flush 后落盘', async () => {
  const marker = `__flush_marker_${Date.now()}__`;
  logger.info(marker);

  await flushLogs();

  const content = readFileSync(todayFile(), 'utf-8');
  assert.ok(content.includes(marker), 'flush 后日志内容应写入文件');
});

test('低等级日志按 LOG_LEVEL 被过滤', async () => {
  // 测试环境 LOG_LEVEL 默认 info，debug 不应落盘
  if (config.log.level !== 'info') return;

  const marker = `__debug_marker_${Date.now()}__`;
  logger.debug(marker);
  await flushLogs();

  const content = readFileSync(todayFile(), 'utf-8');
  assert.ok(!content.includes(marker), 'debug 级别日志在 LOG_LEVEL=info 时不应写入');
});

test('日志文件大小上限配置有效且不会退化到 0', () => {
  assert.ok(config.log.maxSizeBytes >= 1024, '单文件上限至少 1KB，避免每行都轮转');
  assert.ok(config.log.maxFiles >= 1, '至少保留 1 份日志');
});

test('日志时间戳走本地时区，不是 UTC', async () => {
  // 回归保护：早期实现用 toISOString() 打时间戳、并按 UTC 日期切分文件，
  // 在 UTC+8 下会出现"文件名是今天、行内时间是昨天 16:00"的错位。
  const marker = `__tz_marker_${Date.now()}__`;
  logger.info(marker);
  await flushLogs();

  const line = readFileSync(todayFile(), 'utf-8')
    .split('\n')
    .find((l) => l.includes(marker));

  assert.ok(line, '应能在当天日志文件中找到该行');

  const stamp = line.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})\]/);
  assert.ok(stamp, `时间戳格式应为 [YYYY-MM-DD HH:mm:ss]，实际: ${line}`);

  const [, datePart, hh] = stamp;
  assert.equal(datePart, localDate(), '时间戳日期应为本地日期');

  // 时区非 UTC 时，本地小时数必须与 UTC 小时数不同；相同则说明仍在用 UTC
  const utcHour = new Date().getUTCHours();
  const offsetHours = new Date().getTimezoneOffset() / 60;
  if (offsetHours !== 0) {
    assert.notEqual(Number(hh), utcHour, '时间戳小时数不应等于 UTC 小时数（说明误用了 toISOString）');
  }
});
