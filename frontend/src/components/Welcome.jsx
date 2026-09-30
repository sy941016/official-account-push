import { AgentIcon, ChartIcon, PenIcon, DownloadIcon } from './icons.jsx';

const CAPABILITIES = [
  { icon: <ChartIcon size={14} />, title: '热点采集', desc: '爬取微博热搜与抖音热点，自动排序去重' },
  { icon: <PenIcon size={14} />, title: '智能内容创作', desc: '爆款 / 诗意叙事 / 观点犀利 / 治愈温暖 / 干货科普，自带反 AI 检测优化' },
  { icon: <DownloadIcon size={14} />, title: '一键发布', desc: '推送至公众号草稿箱，并同步飞书通知' },
];

/** 首次进入(会话为空)时展示的能力卡片 */
export default function Welcome() {
  return (
    <div className="row agent">
      <div className="avatar" aria-hidden="true"><AgentIcon size={15} /></div>
      <div className="bubble-wrap">
        <div className="bubble bubble--welcome">
          <h2>你好，我是你的公众号内容运营助手</h2>
          <p className="lead">把想做的事直接告诉我。我会自己拆解步骤、调用工具，完成后给你结论。</p>
          <div className="caps">
            {CAPABILITIES.map((c) => (
              <div className="cap" key={c.title}>
                <span className="cap-ico">{c.icon}</span>
                <div><b>{c.title}</b><span>{c.desc}</span></div>
              </div>
            ))}
          </div>
          <p className="tip">提示：涉及发布的动作会真实推送到公众号草稿箱。想先看效果，可以说「只生成不发布」。</p>
        </div>
      </div>
    </div>
  );
}
