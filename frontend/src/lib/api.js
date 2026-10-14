/**
 * 后端接口封装。所有请求统一带上访问令牌头,响应统一解 JSON。
 */

// 访问令牌:服务端配了 WEB_ACCESS_TOKEN 时,页面需要用 ?token=xxx 打开
// (或者之前存过),否则 /api/* 一律 401
export const accessToken =
  new URLSearchParams(window.location.search).get('token') ||
  localStorage.getItem('webAccessToken') || '';

if (accessToken) localStorage.setItem('webAccessToken', accessToken);

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (accessToken) headers['x-web-token'] = accessToken;
  const res = await fetch(path, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON 响应(如网络错误) */ }
  return { res, data };
}

/** 解析一条 SSE 事件块（"event: xxx\ndata: {...}"） */
function parseSseEvent(chunk) {
  let name = 'message';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { name, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

/**
 * 流式对话：/api/chat 返回 SSE，thinking 事件实时推送思考步骤，
 * reply / error 事件收尾。EventSource 不支持 POST，所以用 fetch + reader 手动解析。
 * @returns {Promise<{res: Response, data: {reply?: string, error?: string}}>}
 */
async function chatStream(message, sessionId, handlers = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) headers['x-web-token'] = accessToken;

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, sessionId }),
  });

  // 非 2xx 时后端返回的是 JSON 错误体（未登录/令牌校验等），与 request() 同构返回
  if (!res.ok || !res.body) {
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON */ }
    return { res, data };
  }

  const result = {};
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = parseSseEvent(chunk);
      if (!event) continue;
      if (event.name === 'thinking') handlers.onThinking?.(event.data);
      else if (event.name === 'reply') {
        result.reply = event.data?.reply;
        handlers.onReply?.(event.data);
      } else if (event.name === 'error') {
        result.error = event.data?.error;
        handlers.onError?.(event.data);
      }
    }
  }
  return { res, data: result };
}

export const api = {
  chatStream,
  reset: (sessionId) =>
    request('/api/reset', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  me: () => request('/api/me'),
  articles: (limit = 50) => request(`/api/articles?limit=${limit}`),
  articleContent: (date, id) =>
    request(`/api/articles/content?date=${encodeURIComponent(date)}&id=${encodeURIComponent(id)}`),
  logout: () => request('/api/logout', { method: 'POST' }),
  login: (username, password, remember) =>
    request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, remember }),
    }),
  health: () => request('/health'),
};
