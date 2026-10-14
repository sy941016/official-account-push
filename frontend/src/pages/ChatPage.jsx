import { useCallback, useEffect, useRef, useState } from 'react';
import Topbar from '../components/Topbar.jsx';
import MessageList from '../components/MessageList.jsx';
import Composer from '../components/Composer.jsx';
import { api } from '../lib/api.js';

/**
 * 聊天页。
 * 布局本身由 CSS 媒体查询按屏宽切换;JS 侧只做 touch 判定(焦点策略)
 * 和窄屏 placeholder 切换,阈值与 CSS 的 640px 断点保持一致。
 */
const NARROW_BREAKPOINT = 640;
const IS_TOUCH = (window.matchMedia?.('(hover: none) and (pointer: coarse)').matches)
  || (navigator.maxTouchPoints > 0 && 'ontouchstart' in window);

document.documentElement.dataset.touch = IS_TOUCH ? 'yes' : 'no';

/** 会话没了就回登录页。用 replace 是为了不在历史里留下一条"已经失效的页面" */
function gotoLogin() {
  location.replace('/login');
}

export default function ChatPage() {
  // 渲染项:{ kind: 'msg', role, text } / { kind: 'steps', steps } / { kind: 'notice', text }
  const [items, setItems] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [conn, setConn] = useState({ state: 'connecting', label: '连接中' });
  const [user, setUser] = useState(null);
  const [device, setDevice] = useState(() =>
    (window.innerWidth <= NARROW_BREAKPOINT ? 'mobile' : 'desktop'));
  const [scrollSignal, setScrollSignal] = useState(0);

  const inputRef = useRef(null);
  // 会话 ID 每次刷新都换一个，避免和上一次的上下文串台
  const sessionIdRef = useRef('web_' + Math.random().toString(36).slice(2, 10));
  const offlineNoticedRef = useRef(false);

  const pushItem = useCallback((item) => setItems((prev) => [...prev, item]), []);

  /** 触屏设备不主动抢焦点:会立刻弹起软键盘，把刚生成的长回答挤掉大半 */
  const focusInput = () => {
    if (!IS_TOUCH) inputRef.current?.focus();
  };

  /**
   * 连不上后端时在对话区提示一次。
   * 顶栏那个状态点在手机上是被隐藏的，不额外说一句的话，用户只会看到
   * 一个"正常"的页面、然后发消息时才发现发不出去。
   */
  const noticeOfflineOnce = () => {
    if (offlineNoticedRef.current) return;
    offlineNoticedRef.current = true;
    pushItem({
      kind: 'notice',
      text: '连不上后端服务。请确认后端已启动：npm run web（生产）或 npm run dev（开发，含前端热更新）。',
    });
  };

  /** 探活，把顶栏那个状态点变成真的有用 */
  const pingHealth = async () => {
    try {
      const { res, data } = await api.health();
      const ok = res.ok && data?.status === 'ok';
      setConn(ok
        ? { state: 'ok', label: data?.agentReady ? '服务就绪' : 'Agent 未初始化' }
        : { state: 'bad', label: '服务异常' });
      if (!ok) noticeOfflineOnce();
    } catch {
      setConn({ state: 'bad', label: '后端未连接' });
      noticeOfflineOnce();
    }
  };

  /* ============ 登录态 ============ */

  const loadMe = async () => {
    try {
      const { res, data } = await api.me();
      if (res.status === 401) return gotoLogin();
      if (!res.ok) return;
      // 服务端没启用登录时接口返回空用户名，顶栏保持原样
      if (data?.username) setUser(data.username);
    } catch {
      // 取不到就当作没启用登录，不影响聊天
    }
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } catch {
      // 请求失败也照样回登录页;cookie 没清掉最多是多点一次
    }
    gotoLogin();
  };

  /* ============ 对话 ============ */

  const handleSend = async (text) => {
    if (!text || isLoading) return;

    setIsLoading(true);
    pushItem({ kind: 'msg', role: 'user', text });

    // 流式思考步骤：收到首个事件时才创建卡片，模型直接回复（无工具调用）时不留空卡片
    const steps = [];
    let stepsCardVisible = false;
    const renderSteps = () => {
      const snapshot = [...steps];
      setItems((prev) => {
        if (!stepsCardVisible) {
          stepsCardVisible = true;
          return [...prev, { kind: 'steps', steps: snapshot }];
        }
        const next = [...prev];
        next[next.length - 1] = { kind: 'steps', steps: snapshot };
        return next;
      });
    };

    try {
      const { res, data } = await api.chatStream(text, sessionIdRef.current, {
        onThinking: (step) => {
          steps.push(step);
          renderSteps();
        },
      });

      if (!res.ok) {
        // 会话过期:服务端会在响应体里带 loginRequired，直接送回登录页
        if (data?.loginRequired) return gotoLogin();
        if (res.status === 401) {
          pushItem({
            kind: 'notice',
            text: '访问被拒绝：服务端启用了 WEB_ACCESS_TOKEN，请用 /?token=你的令牌 打开本页',
          });
          return;
        }
        pushItem({ kind: 'notice', text: '出错了：' + (data?.error || '请求失败') });
        return;
      }

      if (data?.error) pushItem({ kind: 'notice', text: '出错了：' + data.error });
      else if (data?.reply) pushItem({ kind: 'msg', role: 'agent', text: data.reply });
    } catch (err) {
      pushItem({ kind: 'notice', text: '网络错误：' + err.message });
    } finally {
      setIsLoading(false);
      focusInput();
    }
  };

  const handleReset = async () => {
    if (isLoading) return;
    try {
      const { res } = await api.reset(sessionIdRef.current);
      if (res.status === 401) return gotoLogin();
      if (!res.ok) throw new Error('HTTP ' + res.status);

      setItems([]);
      setScrollSignal((s) => s + 1);
      focusInput();
    } catch (err) {
      pushItem({ kind: 'notice', text: '清空失败：' + err.message });
    }
  };

  /* ============ 设备形态 ============ */

  // 手机横竖屏切换会跨过断点，所以 resize 时要重算，不能只在加载时算一次
  useEffect(() => {
    const sync = () => {
      const next = window.innerWidth <= NARROW_BREAKPOINT ? 'mobile' : 'desktop';
      setDevice(next);
      document.documentElement.dataset.device = next;
    };
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  /**
   * 软键盘高度同步。
   * iOS 的 100dvh 不随软键盘变化，键盘弹出时整块布局留在原地，输入框会被盖住。
   * 这里把 visualViewport 的真实高度写进 --app-h，让 body 跟着收缩。
   */
  useEffect(() => {
    const vv = window.visualViewport;
    if (!IS_TOUCH || !vv) return;

    const sync = () => {
      // 双指缩放时 visualViewport 会小于布局视口，跟着缩会让整页跳动，直接跳过
      if (vv.scale !== 1) return;
      document.documentElement.style.setProperty('--app-h', vv.height + 'px');
      // 键盘弹出时 iOS 会把页面整体上顶，抵消掉，让布局自己收缩而不是被推走
      if (vv.offsetTop) window.scrollTo(0, 0);
      setScrollSignal((s) => s + 1);
    };

    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  // 启动探活 + 登录态
  useEffect(() => {
    pingHealth();
    const timer = setInterval(pingHealth, 60000);
    loadMe();
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <Topbar conn={conn} user={user} onReset={handleReset} onLogout={handleLogout} />
      <MessageList items={items} isLoading={isLoading} scrollSignal={scrollSignal} />
      <Composer busy={isLoading} device={device} onSend={handleSend} inputRef={inputRef} />
    </>
  );
}
