/**
 * Agent 核心 - ReAct 循环
 *
 * 流程：
 * 1. 接收用户消息 + 对话历史
 * 2. 调用 LLM（带工具定义），LLM 决定下一步
 * 3. 如果需要调用工具 → 执行 → 把结果送回 LLM → 回到 2
 * 4. 如果 LLM 返回最终回复 → 结束
 *
 * 支持 Claude / OpenAI / 豆包 三种 AI 提供商（统一走 ../ai/client.js）
 */

import config from '../../config/index.js';
import logger from '../utils/logger.js';
import { truncate, withRetry } from '../utils/helpers.js';
import { chat } from '../ai/client.js';
import ConversationMemory from './memory.js';
import { getAgentSystemPrompt, buildToolDefinitions } from './prompts.js';
import { getToolDefinitions, executeTool, initToolContext } from './tools.js';

class Agent {
  constructor() {
    this.memory = new ConversationMemory(config.agent?.memorySize || 20);
    this.maxIterations = config.agent?.maxIterations || 10;
    this.maxToolResultChars = config.agent?.maxToolResultChars || 8000;
    this.tools = getToolDefinitions();
    this.systemPrompt = getAgentSystemPrompt();
    this._initialized = false;
  }

  /**
   * 初始化 Agent（注入运行时上下文）
   * @param {Object} context - { stats, cachedTopics, onToolCall }
   */
  init(context = {}) {
    initToolContext(context);
    this._initialized = true;
    logger.info('Agent 初始化完成');
  }

  /**
   * 更新缓存热点（同步到工具层）
   * @param {Array} topics
   */
  updateCachedTopics(topics) {
    this._cachedTopics = topics;
    initToolContext({ cachedTopics: topics });
  }

  /**
   * 执行 Agent（核心方法）
   * @param {string} userMessage 用户消息
   * @param {Object} options - { sessionId, platform, onThinking }
   * @returns {Promise<{reply: string, thinkingSteps: Array, iterations: number}>}
   */
  async run(userMessage, options = {}) {
    const { sessionId = 'default', platform = 'web', onThinking = null } = options;

    if (!this._initialized) this.init();

    this.memory.append(sessionId, { role: 'user', content: userMessage });

    const thinkingSteps = [];
    let finalReply = '';
    let iterations = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      let llmResponse;
      try {
        llmResponse = await this._callLLM(sessionId);
      } catch (err) {
        logger.error(`LLM 调用失败: ${err.message}`);
        finalReply = `抱歉，调用 AI 服务失败：${err.message}`;
        this.memory.append(sessionId, { role: 'assistant', content: finalReply });
        break;
      }

      const { text, toolCalls } = this._parseLLMResponse(llmResponse);

      // 情况1：LLM 返回了文本回复（无工具调用）→ 结束
      if (!toolCalls || toolCalls.length === 0) {
        finalReply = text || '好的，我已了解。还有什么可以帮你的吗？';
        this.memory.append(sessionId, { role: 'assistant', content: finalReply });
        break;
      }

      // 情况2：LLM 需要调用工具
      if (text) {
        thinkingSteps.push({ type: 'thought', content: text });
        onThinking?.({ type: 'thought', content: text });
      }

      this.memory.append(sessionId, {
        role: 'assistant',
        content: text || '',
        tool_calls: toolCalls,
      });

      // 逐个执行工具
      for (const call of toolCalls) {
        const toolName = call.function?.name || call.name;
        const toolId = call.id || `call_${Date.now()}_${thinkingSteps.length}`;
        const { args: toolArgs, parseError } = parseToolArgs(call);

        thinkingSteps.push({ type: 'tool_call', name: toolName, args: toolArgs });
        onThinking?.({ type: 'tool_call', name: toolName, args: toolArgs });

        let result;
        if (parseError) {
          // 参数解析失败时把原因回传给模型，让它自行修正参数重试
          result = { error: `工具参数不是合法 JSON，请重新以合法 JSON 调用：${parseError}` };
        } else {
          try {
            result = await executeTool(toolName, toolArgs);
          } catch (err) {
            result = { error: `工具执行异常: ${err.message}` };
          }
        }

        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        const capped = truncate(resultStr, this.maxToolResultChars);

        thinkingSteps.push({ type: 'tool_result', name: toolName, result: truncate(resultStr, 2000) });
        onThinking?.({ type: 'tool_result', name: toolName, result: truncate(resultStr, 500) });

        this.memory.append(sessionId, {
          role: 'tool',
          content: capped,
          name: toolName,
          tool_call_id: toolId,
        });
      }
    }

    if (!finalReply) {
      finalReply = '抱歉，任务执行超过最大轮次限制，已停止。';
      this.memory.append(sessionId, { role: 'assistant', content: finalReply });
    }

    return { reply: finalReply, thinkingSteps, iterations };
  }

  /**
   * 调用 LLM，带指数退避重试
   * @private
   */
  async _callLLM(sessionId) {
    const messages = this.memory.getHistory(sessionId);
    const tools = buildToolDefinitions(this.tools);

    return withRetry(
      () => chat({ system: this.systemPrompt, messages, tools, temperature: 0.7, maxTokens: 4096 }),
      { retries: config.ai.maxRetries, label: 'Agent LLM 调用' }
    );
  }

  /** @private */
  _parseLLMResponse(response) {
    if (!response) return { text: '', toolCalls: null };
    return { text: response.content || '', toolCalls: response.toolCalls || null };
  }
}

/** 解析工具参数，失败时返回错误原因而不是静默变成空对象 */
function parseToolArgs(call) {
  const raw = call.function?.arguments ?? call.arguments ?? '{}';
  if (typeof raw !== 'string') return { args: raw || {}, parseError: null };
  if (!raw.trim()) return { args: {}, parseError: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { args: {}, parseError: '参数必须是 JSON 对象' };
    }
    return { args: parsed, parseError: null };
  } catch (err) {
    return { args: {}, parseError: err.message };
  }
}

// ===== 导出单例 =====
const agent = new Agent();
export default agent;
