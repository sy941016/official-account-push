import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { AgentIcon } from '../components/icons.jsx';

/**
 * 历史文章页：本地存档列表 + 点击展开正文。
 * 文章在流水线生成时自动落盘（见 src/articles/store.js），
 * 本页数据来源 /api/articles，未登录会被 401 弹回登录页。
 */
export default function ArticlesPage() {
  const [data, setData] = useState({ articles: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** 当前展开的文章：{ key, meta, contentHtml } | { key, error } */
  const [open, setOpen] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { res, data } = await api.articles(100);
        if (res.status === 401) return location.replace('/login');
        if (!res.ok) throw new Error(data?.error || 'HTTP ' + res.status);
        setData(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const toggle = async (item) => {
    const key = `${item.date}/${item.id}`;
    if (open?.key === key) return setOpen(null);
    try {
      const { res, data } = await api.articleContent(item.date, item.id);
      if (!res.ok) throw new Error(data?.error || 'HTTP ' + res.status);
      setOpen({ key, ...data });
    } catch (err) {
      setOpen({ key, error: err.message });
    }
  };

  return (
    <div className="articles-page">
      <header className="articles-topbar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true"><AgentIcon size={19} /></div>
          <h1>历史文章</h1>
          <span className="total">{data.total} 篇</span>
        </div>
        <a className="btn" href="/">返回对话</a>
      </header>

      <main className="articles-list">
        {loading && <p className="hint">加载中…</p>}
        {error && <p className="hint">加载失败：{error}</p>}
        {!loading && !error && data.articles.length === 0 && (
          <p className="hint">
            还没有存档。运行 <code>npm run dry-run</code> 或等定时任务生成文章后，这里会自动出现记录。
          </p>
        )}

        {data.articles.map((item) => {
          const key = `${item.date}/${item.id}`;
          const isOpen = open?.key === key;
          return (
            <article className={'article-item' + (isOpen ? ' open' : '')} key={key}>
              <button className="article-head" onClick={() => toggle(item)}>
                <div className="article-title">{item.title}</div>
                <div className="article-meta">
                  <span>{item.date}</span>
                  <span>{item.source === 'weibo' ? '微博' : '抖音'}</span>
                  <span>{item.style}</span>
                  {typeof item.humanScore === 'number' && (
                    <span className={'score ' + (item.humanScore >= 70 ? 'ok' : 'low')}>
                      人味 {item.humanScore}
                    </span>
                  )}
                  {item.dryRun && <span className="dry">试运行</span>}
                </div>
                {item.digest && <div className="article-digest">{item.digest}</div>}
              </button>
              {isOpen && (
                <div className="article-body">
                  {open.error ? (
                    <p className="hint">读取失败：{open.error}</p>
                  ) : (
                    // 内容是本机流水线自产的文章 HTML（非第三方输入），直接渲染以保留排版
                    <div dangerouslySetInnerHTML={{ __html: open.contentHtml }} />
                  )}
                </div>
              )}
            </article>
          );
        })}
      </main>
    </div>
  );
}
