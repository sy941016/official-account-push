import { CheckIcon, STEP_ICONS } from './icons.jsx';

/** 工具内部名 → 中文展示名 */
const TOOL_NAMES = {
  crawl_weibo: '爬取微博热搜',
  crawl_douyin: '爬取抖音热点',
  generate_article: '生成文章',
  publish_to_wechat: '推送到公众号',
  send_feishu_notification: '发送飞书通知',
  get_system_status: '查询系统状态',
  search_cached_topics: '搜索缓存热点',
};

/** 执行过程卡片:展示 Agent 每一步的思考与工具调用 */
export default function StepsCard({ steps }) {
  if (!steps?.length) return null;

  return (
    <div className="steps">
      <div className="steps-head">
        <CheckIcon size={13} strokeWidth={2.4} />
        <span>执行过程 · {steps.length} 步</span>
      </div>
      <div className="steps-body">
        {steps.map((step, i) => (
          <div className={'step ' + (step.type || 'thought')} key={i}>
            <span className="step-ico">{STEP_ICONS[step.type] || STEP_ICONS.thought}</span>
            <span className="step-text">{renderStepText(step)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function renderStepText(step) {
  if (step.type === 'tool_call') {
    const name = TOOL_NAMES[step.name] || step.name || '未知工具';
    return (
      <>
        <span className="step-tag">调用</span> {name}{' '}
        <span className="mono">{step.name || ''}</span>
      </>
    );
  }

  if (step.type === 'tool_result') {
    const name = TOOL_NAMES[step.name] || step.name || '未知工具';
    const result = String(step.result ?? '');
    const preview = result.length > 140 ? result.slice(0, 140) + '…' : result;
    return (
      <>
        <span className="step-tag">{name}</span> {preview}
      </>
    );
  }

  const content = String(step.content ?? '');
  return content.length > 220 ? content.slice(0, 220) + '…' : content;
}
