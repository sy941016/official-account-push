/**
 * 统一 AI 调用层
 *
 * 之前 agent/core.js 和 ai/generator.js 各自维护了一份 Anthropic / OpenAI 客户端，
 * 且都没有设置超时——一个卡住的请求会把整条流水线挂死。这里收敛成一份：
 *   - 客户端懒加载单例，统一配置 timeout
 *   - 三种 provider 输出统一结构 { content, toolCalls }
 *   - 重试策略交给调用方用 withRetry 控制，SDK 自带重试关闭，避免重试层数叠加
 */
import config from '../../config/index.js';

let _openaiClient = null;
let _claudeClient = null;

export async function getOpenAIClient() {
  if (!_openaiClient) {
    const { default: OpenAI } = await import('openai');
    _openaiClient = new OpenAI({
      apiKey: config.ai.openaiKey,
      timeout: config.ai.requestTimeoutMs,
      maxRetries: 0,
    });
  }
  return _openaiClient;
}

export async function getClaudeClient() {
  if (!_claudeClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    _claudeClient = new Anthropic({
      apiKey: config.ai.anthropicKey,
      timeout: config.ai.requestTimeoutMs,
      maxRetries: 0,
    });
  }
  return _claudeClient;
}

/** 按当前 provider 校验 key 是否就绪，避免发起注定 401 的请求 */
export function assertProviderReady(provider = config.ai.provider) {
  const map = {
    claude: [config.ai.anthropicKey, 'ANTHROPIC_API_KEY'],
    openai: [config.ai.openaiKey, 'OPENAI_API_KEY'],
    doubao: [config.ai.doubaoKey, 'DOUBAO_API_KEY'],
  };
  const entry = map[provider];
  if (!entry) throw new Error(`未知的 AI_PROVIDER: ${provider}`);
  if (!entry[0]) throw new Error(`${entry[1]} 未配置`);
}

/**
 * 统一对话调用
 *
 * @param {Object} params
 * @param {string} params.system      系统提示词
 * @param {Array}  params.messages    消息数组（OpenAI 格式；Claude 由内部转换）
 * @param {Array}  [params.tools]     OpenAI 格式工具定义，不传则不带工具
 * @param {number} [params.temperature=0.7]
 * @param {number} [params.maxTokens=4096]
 * @param {number} [params.frequencyPenalty=0]  -2~2，压低高频词重复率（仅 openai / doubao 生效）
 * @param {number} [params.presencePenalty=0]   -2~2，鼓励引入新词（仅 openai / doubao 生效）
 * @returns {Promise<{content: string, toolCalls: Array|null}>}
 * @throws 输出被 max_tokens 截断时抛错（`err.truncated === true`，不可重试）
 */
export async function chat({
  system,
  messages,
  tools,
  temperature = 0.7,
  maxTokens = 4096,
  frequencyPenalty = 0,
  presencePenalty = 0,
}) {
  const provider = config.ai.provider;
  assertProviderReady(provider);

  const params = { system, messages, tools, temperature, maxTokens, frequencyPenalty, presencePenalty };

  if (provider === 'claude') return callClaude(params);
  if (provider === 'doubao') return callDoubao(params);
  return callOpenAI(params);
}

/**
 * 检查响应是否被 max_tokens 截断，被截断就抛错。
 *
 * 为什么必须查这个：截断时返回的 JSON 一定是残缺的，解析会失败并落到容错解析分支，
 * 结果就是**一篇写到一半的文章照样推进草稿箱**，全程不报错。
 * 宁可明确失败让上层跳过这条选题，也别发半成品出去。
 *
 * 推理模型（如 doubao-seed-evolving）要特别注意：reasoning_tokens 也计入 max_tokens，
 * 思维链越长，留给正文的额度越少。
 *
 * 抛出的错误故意不带 status / code —— withRetry 的 isRetryableError 会判为不可重试。
 * 参数没变，重试只会再截断一次，白白多等几分钟。
 */
function assertNotTruncated(finishReason, maxTokens) {
  if (finishReason !== 'length' && finishReason !== 'max_tokens') return;

  const err = new Error(
    `模型输出被截断（max_tokens=${maxTokens} 不够用）。` +
      `推理模型的 reasoning_tokens 同样占用这个额度，请调大 ARTICLE_MAX_TOKENS。`
  );
  err.truncated = true;
  throw err;
}

// ===== OpenAI =====
async function callOpenAI({ system, messages, tools, temperature, maxTokens, frequencyPenalty, presencePenalty }) {
  const client = await getOpenAIClient();
  const res = await client.chat.completions.create({
    model: config.ai.openaiModel,
    messages: [{ role: 'system', content: system }, ...messages],
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    max_tokens: maxTokens,
    temperature,
    frequency_penalty: frequencyPenalty,
    presence_penalty: presencePenalty,
  });
  const choice = res.choices?.[0];
  assertNotTruncated(choice?.finish_reason, maxTokens);
  return { content: choice?.message?.content || '', toolCalls: choice?.message?.tool_calls || null };
}

// ===== 豆包（OpenAI 兼容协议）=====
async function callDoubao({ system, messages, tools, temperature, maxTokens, frequencyPenalty, presencePenalty }) {
  // 只有豆包走裸 axios，其他 provider 不必为它付出加载成本
  const { default: axios } = await import('axios');

  const res = await axios.post(
    `${config.ai.doubaoBaseUrl}/chat/completions`,
    {
      model: config.ai.doubaoModel,
      messages: [{ role: 'system', content: system }, ...messages],
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
      max_tokens: maxTokens,
      temperature,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.ai.doubaoKey}`,
      },
      timeout: config.ai.requestTimeoutMs,
    }
  );
  const choice = res.data?.choices?.[0];
  assertNotTruncated(choice?.finish_reason, maxTokens);
  return { content: choice?.message?.content || '', toolCalls: choice?.message?.tool_calls || null };
}

// ===== Claude =====
async function callClaude({ system, messages, tools, temperature, maxTokens }) {
  const client = await getClaudeClient();

  const res = await client.messages.create({
    model: config.ai.claudeModel,
    max_tokens: maxTokens,
    temperature,
    system,
    ...(tools?.length
      ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) }
      : {}),
    messages: toClaudeMessages(messages),
  });

  assertNotTruncated(res?.stop_reason, maxTokens);
  return normalizeClaudeResponse(res);
}

/**
 * OpenAI 格式消息 → Claude 格式消息
 * Claude 要求 tool_result 必须出现在携带对应 tool_use 的 assistant 消息之后，
 * 因此连续的 tool 消息会被合并进同一条 user 消息里。
 */
export function toClaudeMessages(messages) {
  const out = [];

  const pushMessage = (role, content) => {
    const prev = out[out.length - 1];
    // 合并连续的同角色消息，避免出现多个相邻 user 块
    if (prev && prev.role === role) {
      prev.content = [...(Array.isArray(prev.content) ? prev.content : [{ type: 'text', text: prev.content }]), ...content];
      return;
    }
    out.push({ role, content });
  };

  for (const msg of messages) {
    if (msg.role === 'system') continue; // system 单独作为顶层参数传入

    if (msg.role === 'user') {
      pushMessage('user', [{ type: 'text', text: msg.content || '' }]);
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks = [];
      if (msg.content) blocks.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls || []) {
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function?.name || tc.name,
          input: parseArgs(tc.function?.arguments ?? tc.arguments),
        });
      }
      if (blocks.length) pushMessage('assistant', blocks);
      continue;
    }

    if (msg.role === 'tool') {
      pushMessage('user', [
        { type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: msg.content || '' },
      ]);
    }
  }

  return out;
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Claude 响应 → 统一结构 */
function normalizeClaudeResponse(response) {
  let content = '';
  const toolCalls = [];

  for (const block of response?.content || []) {
    if (block.type === 'text') content += block.text;
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }

  return { content, toolCalls: toolCalls.length ? toolCalls : null };
}
