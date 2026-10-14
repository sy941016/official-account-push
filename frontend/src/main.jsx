import { createRoot } from 'react-dom/client';
import ChatPage from './pages/ChatPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ArticlesPage from './pages/ArticlesPage.jsx';

/**
 * 单入口三视图:后端把 /、/login、/articles 都伺服到同一个构建产物,
 * 这里按路径决定渲染哪个页面(切换页面走整页跳转,和后端 302 体系保持一致)。
 * 样式只加载当前页那一份,避免同名 class(如 .brand)互相覆盖。
 */
const path = window.location.pathname;
const isLogin = path === '/login';
const isArticles = path === '/articles';

if (isLogin) {
  document.title = '登录 · 公众号内容助手';
  import('./styles/login.css');
} else if (isArticles) {
  document.title = '历史文章 · 公众号内容助手';
  import('./styles/articles.css');
} else {
  import('./styles/chat.css');
}

createRoot(document.getElementById('root')).render(
  isLogin ? <LoginPage /> : isArticles ? <ArticlesPage /> : <ChatPage />
);
