import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config/index.js';
import {
  SESSION_COOKIE,
  isLoginEnabled,
  verifyCredentials,
  createSessionToken,
  verifySessionToken,
  parseCookies,
  buildSessionCookie,
  buildClearCookie,
  checkLoginThrottle,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
} from '../src/web/auth.js';

/**
 * 登录鉴权的单元测试。
 *
 * 注意：auth.js 全程读的是 config.agent.*，而 config 是模块级单例，
 * 所以每个用例都要把用到的键还原（见 withLogin 的 finally）。
 */

const USER = 'tester';
const PASS = 'p@ssw0rd';

/** 临时套上一组登录配置跑 fn，结束后无条件还原 —— 否则后面的用例会串台 */
async function withLogin(fn, overrides = {}) {
  const saved = {
    webLoginUser: config.agent.webLoginUser,
    webLoginPassword: config.agent.webLoginPassword,
    webSessionSecret: config.agent.webSessionSecret,
    webSessionTtlMs: config.agent.webSessionTtlMs,
  };

  Object.assign(config.agent, {
    webLoginUser: USER,
    webLoginPassword: PASS,
    webSessionSecret: '',
    webSessionTtlMs: 12 * 3600_000,
    ...overrides,
  });

  resetLoginThrottle();
  try {
    return await fn();
  } finally {
    Object.assign(config.agent, saved);
    resetLoginThrottle();
  }
}

test('未配置账号密码时不启用登录', async () => {
  // 断言必须放在 withLogin 内部：还原之后读到的是本机 .env 的真实配置，
  // 那里面很可能已经配了账号，用它来断言"未启用"就会假失败
  await withLogin(async () => {
    assert.equal(isLoginEnabled(), false);
    assert.equal(verifyCredentials(USER, PASS), false);
  }, { webLoginUser: '', webLoginPassword: '' });
});

test('只配了账号或只配了密码都不算启用', async () => {
  await withLogin(async () => {
    assert.equal(isLoginEnabled(), false);
  }, { webLoginPassword: '' });

  await withLogin(async () => {
    assert.equal(isLoginEnabled(), false);
  }, { webLoginUser: '' });
});

test('verifyCredentials 只认完全一致的账号密码', async () => {
  await withLogin(async () => {
    assert.equal(verifyCredentials(USER, PASS), true);
    assert.equal(verifyCredentials(USER, 'wrong'), false);
    assert.equal(verifyCredentials('someone', PASS), false);
    assert.equal(verifyCredentials('', ''), false);
    // 非字符串入参不能把服务打崩（JSON body 里什么都可能传进来）
    assert.equal(verifyCredentials(null, undefined), false);
    assert.equal(verifyCredentials({ toString: () => PASS }, PASS), false);
  });
});

test('未启用登录时任何账号密码都不通过', async () => {
  await withLogin(async () => {
    assert.equal(verifyCredentials(USER, PASS), false);
  }, { webLoginUser: '', webLoginPassword: '' });
});

test('会话 token 签发后可以验回用户名', async () => {
  await withLogin(async () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(USER, now);
    const session = verifySessionToken(token, now + 1000);
    assert.equal(session.username, USER);
    assert.equal(session.exp, now + config.agent.webSessionTtlMs);
  });
});

test('过期 token 验不过', async () => {
  await withLogin(async () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(USER, now);
    assert.equal(verifySessionToken(token, now + config.agent.webSessionTtlMs + 1), null);
  });
});

test('篡改 payload 或签名都会被拒', async () => {
  await withLogin(async () => {
    const token = createSessionToken(USER);
    const [payload, signature] = token.split('.');

    // 换掉 payload（把用户名改成别人）—— 签名对不上
    const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 60_000 })).toString('base64url');
    assert.equal(verifySessionToken(`${forged}.${signature}`), null);

    // 换掉签名
    assert.equal(verifySessionToken(`${payload}.AAAA`), null);

    // 结构不完整
    assert.equal(verifySessionToken(payload), null);
    assert.equal(verifySessionToken(''), null);
    assert.equal(verifySessionToken(undefined), null);
    assert.equal(verifySessionToken(`.${signature}`), null);
  });
});

test('账号改掉之后旧会话立即失效', async () => {
  let token;
  await withLogin(async () => {
    token = createSessionToken(USER);
    assert.ok(verifySessionToken(token));
  });

  await withLogin(async () => {
    // 同一枚 token、同一套签名密钥（密钥由账号密码派生），但账号已经不是它了
    assert.equal(verifySessionToken(token), null);
  }, { webLoginUser: 'someone_else' });
});

test('parseCookies 能解析多个 cookie，坏值不影响其它项', () => {
  const cookies = parseCookies(`${SESSION_COOKIE}=abc.def; theme=dark; broken=%E4%B8; empty=`);
  assert.equal(cookies[SESSION_COOKIE], 'abc.def');
  assert.equal(cookies.theme, 'dark');
  assert.equal(cookies.broken, '%E4%B8'); // 非法转义按原样保留
  assert.equal(cookies.empty, '');
  assert.deepEqual(parseCookies(undefined), {});
});

test('会话 cookie 带 HttpOnly / SameSite，记住我控制 Max-Age', async () => {
  await withLogin(async () => {
    const persistent = buildSessionCookie('tok');
    assert.match(persistent, /HttpOnly/);
    assert.match(persistent, /SameSite=Lax/);
    assert.match(persistent, /Path=\//);
    assert.match(persistent, /Max-Age=43200/);

    const sessionOnly = buildSessionCookie('tok', false);
    assert.ok(!sessionOnly.includes('Max-Age'), '不记住我时不该带 Max-Age');

    assert.match(buildClearCookie(), /Max-Age=0/);
  });
});

test('登录失败累计到阈值后封锁来源', async () => {
  await withLogin(async () => {
    const now = 1_700_000_000_000;
    const ip = '127.0.0.1';

    for (let i = 1; i <= 4; i++) {
      const state = recordLoginFailure(ip, now);
      assert.equal(state.blocked, false, `第 ${i} 次失败不该封锁`);
      assert.equal(state.remaining, 5 - i);
    }

    const fifth = recordLoginFailure(ip, now);
    assert.equal(fifth.blocked, true);
    assert.ok(fifth.retryAfterSec > 0);

    // 封锁期内查询也是封锁状态，且不同来源互不影响
    assert.equal(checkLoginThrottle(ip, now + 1000).blocked, true);
    assert.equal(checkLoginThrottle('10.0.0.1', now + 1000).blocked, false);

    // 封锁到期后重新开始计数
    assert.equal(checkLoginThrottle(ip, now + 5 * 60_000 + 1).blocked, false);
  });
});

test('登录成功清掉该来源的失败记录', async () => {
  await withLogin(async () => {
    const ip = '127.0.0.1';
    recordLoginFailure(ip);
    recordLoginFailure(ip);
    assert.equal(checkLoginThrottle(ip).remaining, 3);

    recordLoginSuccess(ip);
    assert.equal(checkLoginThrottle(ip).remaining, 5);
  });
});
