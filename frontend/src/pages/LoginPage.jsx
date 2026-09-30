import { useEffect, useRef, useState } from 'react';
import {
  AgentIcon, SunIcon, HomeIcon, CheckIcon,
  UserIcon, LockIcon, EyeIcon, EyeOffIcon, AlertIcon,
} from '../components/icons.jsx';
import { api } from '../lib/api.js';

const FEATURES = [
  { icon: <SunIcon size={14} />, text: '实时抓取微博、抖音热搜榜' },
  { icon: <HomeIcon size={14} />, text: '按指定文风成稿，自动去 AI 味' },
  { icon: <CheckIcon size={14} />, text: '配图、排版、草稿推送一次到位' },
];

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [showPwd, setShowPwd] = useState(false);
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState(null); // { text, seq }，seq 递增用于重放抖动动画
  const [notServedHint, setNotServedHint] = useState('');

  const userRef = useRef(null);
  const pwdRef = useRef(null);

  const showAlert = (text) => setAlert((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
  const hideAlert = () => setAlert(null);

  /* ============ 页面来源自检 ============ */
  // 这个页面经常被当成静态文件打开（直接双击 html、或在编辑器/预览面板里打开），
  // 那种情况下 /api/* 压根不存在，登录 100% 失败，但报出来只是"HTTP 404"，
  // 很容易被误判成密码错。启动时先探一下 /health，把话说清楚。
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/health', { cache: 'no-store' });
        if (res.ok) return;
      } catch { /* 探不通 = 没被服务托管 */ }

      const hint = location.protocol === 'file:'
        ? '这是直接打开的本地文件，登录接口不可用。请先运行 npm run web，再访问 http://localhost:3000'
        : '当前页面不是由服务提供的（找不到 /health），无法登录。请先运行 npm run web，再访问 http://localhost:3000';
      setNotServedHint(hint);
      showAlert(hint);
    })();
    userRef.current?.focus();
  }, []);

  const handlePeek = () => {
    setShowPwd((v) => !v);
    pwdRef.current?.focus();
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (loading) return;

    // 页面没被服务托管，发出去也是白跑一趟，直接把原因摆出来
    if (notServedHint) { showAlert(notServedHint); return; }

    const name = username.trim();

    if (!name) { showAlert('请先填写账号'); userRef.current?.focus(); return; }
    if (!password) { showAlert('请先填写密码'); pwdRef.current?.focus(); return; }

    hideAlert();
    setLoading(true);

    try {
      const { res, data } = await api.login(name, password, remember);

      if (res.ok) {
        location.replace('/');
        return;
      }

      if (res.status === 401) {
        setPassword('');
        pwdRef.current?.focus();
      }
      showAlert(data?.error || `登录失败（HTTP ${res.status}）`);
    } catch {
      showAlert('无法连接服务，请确认服务已启动后重试');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="stage">

      <aside className="brand-pane">
        <div className="aurora" aria-hidden="true">
          <span className="blob b1"></span>
          <span className="blob b2"></span>
          <span className="blob b3"></span>
        </div>
        <div className="grid-lines" aria-hidden="true"></div>

        <div className="brand-pane-inner">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true"><AgentIcon size={20} /></div>
            <div className="brand-name">
              <strong>公众号内容助手</strong>
              <span>AI AGENT</span>
            </div>
          </div>

          <div className="pitch">
            <p className="eyebrow">HOTSPOT · WRITING · PUBLISHING</p>
            <h1>把今天的<span className="hl">热点</span><br />写成能发出去的稿子</h1>
            <p className="pitch-sub">从热搜采集到公众号草稿箱，一条链路跑完，中间不用再换工具。</p>

            <ul className="features">
              {FEATURES.map((f) => (
                <li key={f.text}>
                  <span className="ico" aria-hidden="true">{f.icon}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </aside>

      <main className="form-pane">
        <div className="mobile-brand">
          <div className="brand-mark" aria-hidden="true"><AgentIcon size={17} /></div>
          <div className="name">
            <strong>公众号内容助手</strong>
            <span>AI AGENT</span>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>欢迎回来</h2>
            <p>登录后进入公众号内容助手</p>
          </div>

          <form onSubmit={handleSubmit} noValidate>
            <div className="field">
              <label htmlFor="username">账号</label>
              <div className="control">
                <span className="ico" aria-hidden="true"><UserIcon size={16} /></span>
                <input
                  id="username"
                  name="username"
                  type="text"
                  placeholder="请输入账号"
                  autoComplete="username"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck="false"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  ref={userRef}
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="password">密码</label>
              <div className="control">
                <span className="ico" aria-hidden="true"><LockIcon size={16} /></span>
                <input
                  id="password"
                  name="password"
                  type={showPwd ? 'text' : 'password'}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  ref={pwdRef}
                />
                <button
                  type="button"
                  className={'peek' + (showPwd ? ' is-on' : '')}
                  aria-label={showPwd ? '隐藏密码' : '显示密码'}
                  aria-pressed={showPwd}
                  onClick={handlePeek}
                >
                  <EyeIcon size={16} className="eye-on" />
                  <EyeOffIcon size={16} className="eye-off" />
                </button>
              </div>
            </div>

            <div className="row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                <span className="box" aria-hidden="true">
                  <CheckIcon size={11} strokeWidth={3.4} />
                </span>
                <span>记住我</span>
              </label>
              <span className="hint">忘记密码请联系管理员</span>
            </div>

            {alert && (
              <div className="alert" key={alert.seq} role="alert" aria-live="assertive">
                <AlertIcon size={15} />
                <span>{alert.text}</span>
              </div>
            )}

            <button className={'submit' + (loading ? ' is-loading' : '')} type="submit" disabled={loading}>
              <span className="spinner" aria-hidden="true"></span>
              <span className="label">登录</span>
            </button>
          </form>

          <div className="card-foot">
            <span>公众号内容助手</span>
            <span>v2.2.0</span>
          </div>
        </div>
      </main>

    </div>
  );
}
