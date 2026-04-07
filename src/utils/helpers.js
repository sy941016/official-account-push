/**
 * 通用工具函数
 */

/**
 * 延迟指定毫秒
 * @param {number} ms
 * @returns {Promise<void>}
 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
