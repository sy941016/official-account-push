import { AgentIcon } from './icons.jsx';

/**
 * 顶栏:品牌标识 + 服务状态点 + 当前账号 + 清空/退出。
 * conn = { state: 'connecting'|'ok'|'bad', label }
 */
export default function Topbar({ conn, user, onReset, onLogout }) {
  const pillClass = 'status-pill' + (conn.state === 'ok' ? ' is-ok' : conn.state === 'bad' ? ' is-bad' : '');

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true"><AgentIcon size={19} /></div>
        <div className="brand-text">
          <h1><span className="title-full">公众号内容助手</span><span className="title-short">内容助手</span></h1>
          <p>热点采集 · AI 写作 · 自动发布</p>
        </div>
      </div>
      <div className="topbar-actions">
        <span className={pillClass}><span className="dot"></span><span>{conn.label}</span></span>
        <span className="user-chip" hidden={!user}>
          <span className="avatar" aria-hidden="true">{user ? user.slice(0, 1) : ''}</span>
          <span id="userName">{user}</span>
        </span>
        <button className="btn" onClick={onReset}><span className="wide-only">清空会话</span><span className="narrow-only">清空</span></button>
        <button className="btn" onClick={onLogout} hidden={!user}><span className="wide-only">退出登录</span><span className="narrow-only">退出</span></button>
      </div>
    </header>
  );
}
