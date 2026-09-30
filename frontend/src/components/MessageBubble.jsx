import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from '../lib/markdown.jsx';
import { AgentIcon } from './icons.jsx';

/** 单条消息气泡。agent 侧带 Markdown 渲染和复制按钮 */
export default function MessageBubble({ role, text }) {
  const [copyLabel, setCopyLabel] = useState('复制');
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const flash = (label) => {
    setCopyLabel(label);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopyLabel('复制'), 1500);
  };

  const handleCopy = () => {
    navigator.clipboard?.writeText(text).then(
      () => flash('已复制'),
      () => flash('复制失败')
    );
  };

  return (
    <div className={'row ' + role}>
      <div className="avatar" aria-hidden="true">
        {role === 'agent' ? <AgentIcon size={15} /> : '我'}
      </div>
      <div className="bubble-wrap">
        <div className="bubble">{role === 'agent' ? renderMarkdown(text) : text}</div>
        {role === 'agent' && (
          <div className="msg-tools">
            <button className="tool-btn" onClick={handleCopy}>{copyLabel}</button>
          </div>
        )}
      </div>
    </div>
  );
}
