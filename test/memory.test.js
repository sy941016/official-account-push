import test from 'node:test';
import assert from 'node:assert/strict';
import ConversationMemory, { sanitizeMessages } from '../src/agent/memory.js';

const assistantWithCalls = (id = 'c1') => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, function: { name: 'crawl_weibo', arguments: '{}' } }],
});

/** 工具消息必须紧跟一条携带对应 tool_calls 的 assistant，否则模型接口会报 400 */
function assertNoOrphanTool(history) {
  for (let i = 0; i < history.length; i++) {
    if (history[i].role !== 'tool') continue;
    const prev = history[i - 1];
    assert.ok(
      prev && prev.role === 'assistant' && prev.tool_calls?.length,
      `位置 ${i} 的 tool 消息没有对应的 assistant tool_calls`
    );
  }
}

test('滑动窗口裁剪后不会留下孤儿 tool 消息', () => {
  const memory = new ConversationMemory(5);

  memory.append('s1', { role: 'user', content: '看看热点' });
  memory.append('s1', assistantWithCalls('c1'));
  memory.append('s1', { role: 'tool', content: '[]', tool_call_id: 'c1' });
  memory.append('s1', { role: 'user', content: '写一篇文章' });
  memory.append('s1', assistantWithCalls('c2'));
  memory.append('s1', { role: 'tool', content: '[]', tool_call_id: 'c2' });
  memory.append('s1', { role: 'user', content: '再写一篇' });

  const history = memory.getHistory('s1');
  assert.ok(history.length <= 5, `窗口应被裁剪到 5 条以内，实际 ${history.length}`);
  assertNoOrphanTool(history);
  assert.notEqual(history[0].role, 'tool', '头部不应是孤儿 tool 消息');
});

test('窗口裁剪到只剩 tool 消息时会被全部清掉', () => {
  const memory = new ConversationMemory(4);
  memory.append('s1', { role: 'user', content: 'hi' });
  memory.append('s1', assistantWithCalls('c1'));
  memory.append('s1', { role: 'tool', content: 'r1', tool_call_id: 'c1' });
  memory.append('s1', { role: 'tool', content: 'r2', tool_call_id: 'c2' });
  memory.append('s1', { role: 'user', content: 'next' });
  memory.append('s1', { role: 'user', content: 'again' });

  const history = memory.getHistory('s1');
  assert.ok(history.length > 0);
  assert.notEqual(history[0].role, 'tool');
  assertNoOrphanTool(history);
});

test('sanitizeMessages 去掉开头的孤儿 tool 消息', () => {
  const out = sanitizeMessages([
    { role: 'tool', content: 'x', tool_call_id: 'c1' },
    { role: 'user', content: 'hi' },
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user']);
});

test('sanitizeMessages 去掉结尾没有结果的 assistant tool_calls', () => {
  const out = sanitizeMessages([
    { role: 'user', content: 'hi' },
    assistantWithCalls(),
  ]);
  assert.deepEqual(out.map((m) => m.role), ['user']);
});

test('sanitizeMessages 为缺失 tool_call_id 的 tool 消息回填 id', () => {
  const out = sanitizeMessages([
    { role: 'user', content: 'hi' },
    assistantWithCalls('call_abc'),
    { role: 'tool', content: 'r1' },
  ]);
  assert.equal(out[2].tool_call_id, 'call_abc');
});

test('会话按 LRU 淘汰，不会无限增长', () => {
  const memory = new ConversationMemory(10, 2);
  memory.append('a', { role: 'user', content: '1' });
  memory.append('b', { role: 'user', content: '2' });
  memory.append('c', { role: 'user', content: '3' });

  assert.equal(memory.sessionCount, 2);
  assert.equal(memory.size('a'), 0, '最早的会话应被淘汰');
  assert.equal(memory.size('c'), 1);
});

test('getHistory 返回副本，外部修改不影响内部状态', () => {
  const memory = new ConversationMemory(10);
  memory.append('s1', { role: 'user', content: 'hi' });

  const history = memory.getHistory('s1');
  history.push({ role: 'user', content: '注入' });

  assert.equal(memory.size('s1'), 1);
});
