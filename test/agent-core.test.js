/**
 * Agent ReAct 循环测试
 *
 * 不打真实模型接口：config.ai 指向本地 mock（豆包是 OpenAI 兼容协议），
 * 按队列返回预设响应，断言 ReAct 循环各分支的行为：
 *   - 直接回复一轮结束 / 工具调用循环 / 空内容兜底
 *   - 非法参数与未知工具：不崩溃，错误回传给模型自行修正
 *   - 最大轮次截停 / LLM 失败不污染会话历史 / 中止信号
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import config from '../config/index.js';

// ===== mock LLM =====

const state = {
  /** 依次返回的响应：{ content, toolCalls? } | { status: 500 }；用完后复用最后一个 */
  queue: [],
  /** 收到的请求体 */
  requests: [],
};

function startMockServer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // 环境有 HTTP_PROXY 时 req.url 可能是绝对形式，必须用 URL 解析
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (pathname !== '/chat/completions') {
        res.writeHead(404).end('not found');
        return;
      }
      state.requests.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));

      const item = state.queue.length > 1 ? state.queue.shift() : state.queue[0] || { content: '好的。' };
      if (item.status && item.status !== 200) {
        res.writeHead(item.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock upstream error' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: item.toolCalls ? 'tool_calls' : 'stop',
              message: {
                role: 'assistant',
                content: item.content ?? null,
                ...(item.toolCalls ? { tool_calls: item.toolCalls } : {}),
              },
            },
          ],
        })
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.unref(); // 不阻塞测试进程退出，无需显式 close
      resolve({ base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// ===== 夹具 =====

// Node 18 的 test runner：顶层 before/after 不执行，顶层 await 与异步 hook 中
// server.listen 会死锁。mock 服务改为用例内懒初始化，配置还原挂到 process exit。
let mock;
let agent;
const saved = {};

let sessionSeq = 0;
/** 每个用例用独立 sessionId，避免共享单例的对话历史串台 */
const freshSession = () => `test_agent_${process.pid}_${++sessionSeq}`;

async function ensureMock() {
  if (!mock) {
    await import('axios'); // 预热懒加载依赖，避免首次加载拖垮本地 mock 连接

    mock = await startMockServer();

    Object.assign(saved, {
      provider: config.ai.provider,
      doubaoKey: config.ai.doubaoKey,
      doubaoBaseUrl: config.ai.doubaoBaseUrl,
      maxRetries: config.ai.maxRetries,
    });

    config.ai.provider = 'doubao';
    config.ai.doubaoKey = 'test-key';
    config.ai.doubaoBaseUrl = mock.base;
    config.ai.maxRetries = 0; // 失败立即抛出，测试要快

    ({ default: agent } = await import('../src/agent/core.js'));

    process.on('exit', () => {
      Object.assign(config.ai, {
        provider: saved.provider,
        doubaoKey: saved.doubaoKey,
        doubaoBaseUrl: saved.doubaoBaseUrl,
        maxRetries: saved.maxRetries,
      });
    });
  }

  // 每个用例前从干净状态开始
  state.queue = [];
  state.requests = [];
}

// 用例统一入口：先确保 mock 就绪再执行用例体
const t = (name, fn) =>
  test(name, async () => {
    await ensureMock();
    await fn();
  });

/** 构造一个 OpenAI 格式的工具调用；args 传字符串时原样作为 arguments（可模拟非法 JSON） */
function toolCall(name, args = {}, id = 'call_1') {
  return {
    id,
    type: 'function',
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  };
}

// ===== 用例 =====

t('模型直接回复时一轮结束，无思考步骤', async () => {
  const sid = freshSession();
  state.queue = [{ content: '你好，有什么可以帮你？' }];

  const result = await agent.run('你好', { sessionId: sid });

  assert.equal(result.reply, '你好，有什么可以帮你？');
  assert.equal(result.iterations, 1);
  assert.equal(result.aborted, false);
  assert.deepEqual(result.thinkingSteps, []);

  // 对话历史应是 user + assistant 两条
  const history = agent.memory.getHistory(sid);
  assert.deepEqual(history.map((m) => m.role), ['user', 'assistant']);
});

t('模型返回空内容时使用兜底文案', async () => {
  state.queue = [{ content: null }];

  const result = await agent.run('嗯', { sessionId: freshSession() });

  assert.ok(result.reply.length > 0, '空内容必须有兜底回复');
  assert.equal(result.iterations, 1);
});

t('工具调用循环：工具结果回传后模型给出最终回复', async () => {
  const sid = freshSession();
  state.queue = [
    { content: '我先查一下系统状态', toolCalls: [toolCall('get_system_status')] },
    { content: '系统运行正常。' },
  ];

  const events = [];
  const result = await agent.run('看看系统状态', {
    sessionId: sid,
    onThinking: (s) => events.push(s),
  });

  assert.equal(result.reply, '系统运行正常。');
  assert.equal(result.iterations, 2);

  // 思考事件顺序：想法 → 工具调用 → 工具结果
  assert.deepEqual(events.map((s) => s.type), ['thought', 'tool_call', 'tool_result']);
  assert.equal(events[1].name, 'get_system_status');

  // 第二次请求必须携带 tool 消息（工具结果回传给模型）
  const toolMsg = state.requests[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '第二次请求应携带 tool 消息');
  assert.equal(toolMsg.tool_call_id, 'call_1');
  assert.ok(toolMsg.content.includes('aiProvider'), '工具执行结果应回传给模型');
});

t('工具参数不是合法 JSON 时不执行工具，错误原因回传给模型', async () => {
  state.queue = [
    { content: '', toolCalls: [toolCall('get_system_status', '{oops')] },
    { content: '参数格式有误，我重新回答。' },
  ];

  const result = await agent.run('查状态', { sessionId: freshSession() });

  assert.equal(result.reply, '参数格式有误，我重新回答。');
  const toolMsg = state.requests[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, '参数错误也应以 tool 消息回传');
  assert.ok(toolMsg.content.includes('不是合法 JSON'));
});

t('模型编造不存在的工具时不崩溃，异常回传后继续', async () => {
  state.queue = [
    { content: '', toolCalls: [toolCall('fly_to_moon')] },
    { content: '这个工具不存在，我直接回答。' },
  ];

  const result = await agent.run('带我去月球', { sessionId: freshSession() });

  assert.equal(result.reply, '这个工具不存在，我直接回答。');
  const toolMsg = state.requests[1].messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg.content.includes('未知工具'));
});

t('工具调用永不停止时达到最大轮次（10）截停', async () => {
  state.queue = [{ content: '', toolCalls: [toolCall('get_system_status')] }];

  const result = await agent.run('无限循环', { sessionId: freshSession() });

  assert.equal(result.iterations, 10);
  assert.ok(result.reply.includes('最大轮次'));
  assert.equal(state.requests.length, 10, '每轮一次 LLM 请求');
});

t('LLM 调用失败时不把错误回复写进会话历史', async () => {
  const sid = freshSession();
  state.queue = [{ status: 500 }];

  const first = await agent.run('你好', { sessionId: sid });
  assert.ok(first.reply.includes('调用 AI 服务失败'));

  // 服务恢复后再次对话：发给模型的历史里不该出现上一次的失败文案
  state.queue = [{ content: '我在，请讲。' }];
  state.requests = [];
  const second = await agent.run('还在吗', { sessionId: sid });
  assert.equal(second.reply, '我在，请讲。');

  const sent = JSON.stringify(state.requests[0].messages);
  assert.ok(!sent.includes('调用 AI 服务失败'), '失败回复不应进入对话历史');
});

t('中止信号在下一轮开始前生效，且历史里 tool_calls 与结果成对', async () => {
  const sid = freshSession();
  const controller = new AbortController();
  state.queue = [
    { content: '', toolCalls: [toolCall('get_system_status')] },
    { content: '这句回复不应被采用' },
  ];

  // 第一轮工具结果产出后立即中止：循环应在进入第二轮前退出
  const result = await agent.run('查状态', {
    sessionId: sid,
    signal: controller.signal,
    onThinking: (s) => {
      if (s.type === 'tool_result') controller.abort();
    },
  });

  assert.equal(result.aborted, true);
  assert.equal(result.iterations, 1, '不应进入第二轮');
  assert.ok(result.reply.includes('超时'));

  // 历史完整性：assistant 的 tool_calls 必须有对应 tool 结果，否则下一轮请求会被接口 400 拒绝
  const history = agent.memory.getHistory(sid);
  const assistantMsg = history.find((m) => m.tool_calls?.length);
  const toolMsg = history.find((m) => m.role === 'tool');
  assert.ok(assistantMsg && toolMsg, 'tool_calls 与 tool_result 必须成对出现');
  assert.equal(toolMsg.tool_call_id, assistantMsg.tool_calls[0].id);
});
