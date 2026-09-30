import { createRoot } from 'react-dom/client';
import ChatPage from './pages/ChatPage.jsx';
import LoginPage from './pages/LoginPage.jsx';

/**
 * 单入口双视图:后端把 / 和 /login 都伺服到同一个构建产物,
 * 这里按路径决定渲染哪个页面(切换页面走整页跳转,和后端 302 体系保持一致)。
 * 两套样式只加载当前页的那一份,避免同名 class(如 .brand)互相覆盖。
 */
const isLogin = window.location.pathname === '/login';

if (isLogin) {
  document.title = '登录 · 公众号内容助手';
  import('./styles/login.css');
} else {
  import('./styles/chat.css');
}

createRoot(document.getElementById('root')).render(isLogin ? <LoginPage /> : <ChatPage />);
