/**
 * Agent 对话记忆管理
 * - 按会话 (sessionId) 隔离多用户
 * - 维护最近 N 条消息（滑动窗口）
 * - 支持追加 Agent 思考过程（工具调用记录）
 *
 * 关键约束：窗口裁剪不能把 `assistant(tool_calls)` 和它对应的 `tool` 结果切散。
 * 一旦切散，发给 OpenAI / Claude 的消息序列就是非法的，接口会直接返回 400。
 * 因此裁剪后统一走 sanitize() 做一次结构修复。
 */

const DEFAULT_MEMORY_SIZE = 20;
const DEFAULT_MAX_SESSIONS = 500;

/**
 * @typedef {Object} Message
 * @property {'user'|'assistant'|'tool'|'system'} role
 * @property {string} content
 * @property {string} [name]         - tool 消息的工具名
 * @property {string} [tool_call_id] - 对应的 tool_call id
 * @property {Array}  [tool_calls]   - assistant 消息携带的工具调用
 */

class ConversationMemory {
  /**
   * @param {number} maxSize      每个会话保留的最大消息条数
   * @param {number} maxSessions  最多保留的会话数（LRU 淘汰，防止长期运行内存泄漏）
   */
  constructor(maxSize = DEFAULT_MEMORY_SIZE, maxSessions = DEFAULT_MAX_SESSIONS) {
    this.maxSize = Math.max(4, maxSize);
    this.maxSessions = maxSessions;
    /** @type {Map<string, Message[]>} */
    this.sessions = new Map();
  }

  /**
   * 获取指定会话的对话历史（浅拷贝 + 结构修复，可直接发给模型）
   * @param {string} sessionId
   * @returns {Message[]}
   */
  getHistory(sessionId) {
    const history = this.sessions.get(sessionId);
    if (!history) return [];
    this._touch(sessionId);
    return sanitizeMessages(history);
  }

  /**
   * 追加一条消息到指定会话
   * @param {string} sessionId
   * @param {Message} message
   */
  append(sessionId, message) {
    let history = this.sessions.get(sessionId);
    if (!history) {
      history = [];
      this.sessions.set(sessionId, history);
    }
    history.push(message);
    this._trim(history);
    this._touch(sessionId);
    this._evictIfNeeded();
  }

  /**
   * 批量追加消息
   * @param {string} sessionId
   * @param {Message[]} messages
   */
  appendBatch(sessionId, messages) {
    for (const msg of messages) this.append(sessionId, msg);
  }

  /**
   * 清空指定会话
   * @param {string} sessionId
   */
  clear(sessionId) {
    this.sessions.delete(sessionId);
  }

  /** 清空所有会话 */
  clearAll() {
    this.sessions.clear();
  }

  /**
   * 获取当前会话的消息数量
   * @param {string} sessionId
   * @returns {number}
   */
  size(sessionId) {
    return (this.sessions.get(sessionId) || []).length;
  }

  /** 当前活跃会话数 */
  get sessionCount() {
    return this.sessions.size;
  }

  // ===== 内部 =====

  /** 超出窗口时从头部裁剪 */
  _trim(history) {
    while (history.length > this.maxSize) {
      history.shift();
    }
    // 头部残留的孤儿 tool 消息（其 assistant 已被裁掉）必须清掉，
    // 否则模型接口会因为"没有对应的 tool_call"而报错
    while (history.length > 0 && history[0].role === 'tool') {
      history.shift();
    }
  }

  /** 标记最近使用（Map 的插入顺序即 LRU 顺序） */
  _touch(sessionId) {
    const history = this.sessions.get(sessionId);
    if (!history) return;
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, history);
  }

  _evictIfNeeded() {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      this.sessions.delete(oldest);
    }
  }
}

/**
 * 修复消息序列，使其满足模型接口的结构要求：
 * 1. 去掉开头的孤儿 tool 消息
 * 2. 去掉结尾没有对应 tool 结果的 assistant(tool_calls)
 * 3. 补齐 tool 消息缺失的 tool_call_id（用同批 assistant 的调用顺序回填）
 *
 * @param {Message[]} messages
 * @returns {Message[]}
 */
export function sanitizeMessages(messages) {
  let out = [...messages];

  while (out.length > 0 && out[0].role === 'tool') out.shift();

  const last = out[out.length - 1];
  if (last && last.role === 'assistant' && last.tool_calls?.length) {
    out.pop();
  }

  // 回填缺失的 tool_call_id：按上一条 assistant 的 tool_calls 顺序匹配
  let pendingIds = [];
  out = out.map((msg) => {
    if (msg.role === 'assistant' && msg.tool_calls?.length) {
      pendingIds = msg.tool_calls.map((tc) => tc.id).filter(Boolean);
      return msg;
    }
    if (msg.role === 'tool') {
      if (msg.tool_call_id) {
        pendingIds = pendingIds.filter((id) => id !== msg.tool_call_id);
        return msg;
      }
      const [nextId = ''] = pendingIds;
      pendingIds = pendingIds.slice(1);
      return { ...msg, tool_call_id: nextId };
    }
    return msg;
  });

  return out;
}

export default ConversationMemory;
