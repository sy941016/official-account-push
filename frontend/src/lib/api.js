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

export const api = {
  chat: (message, sessionId) =>
    request('/api/chat', { method: 'POST', body: JSON.stringify({ message, sessionId }) }),
  reset: (sessionId) =>
    request('/api/reset', { method: 'POST', body: JSON.stringify({ sessionId }) }),
  me: () => request('/api/me'),
  logout: () => request('/api/logout', { method: 'POST' }),
  login: (username, password, remember) =>
    request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password, remember }),
    }),
  health: () => request('/health'),
};
