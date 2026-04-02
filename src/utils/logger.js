import { mkdirSync, appendFileSync } from 'fs';
import { config } from '../../config/index.js';

mkdirSync('logs', { recursive: true });

const logLevels = ['debug', 'info', 'warn', 'error'];
const levelIndex = logLevels.indexOf(config.run.logLevel) || 1;

function getTimestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(level, message, meta = {}) {
  if (logLevels.indexOf(level) < levelIndex) return;
  
  const timestamp = getTimestamp();
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  const logMessage = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] ${message}${metaStr}`;
  
  // 控制台输出
  const consoleMethod = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  consoleMethod(logMessage);
  
  // 文件输出
  try {
    const logFile = `logs/${new Date().toISOString().slice(0, 10)}.log`;
    appendFileSync(logFile, logMessage + '\n');
  } catch (err) {
    console.error('日志文件写入失败:', err.message);
  }
}

export const logger = {
  debug: (message, meta) => log('debug', message, meta),
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};

export default logger;
