import { useRef, useState } from 'react';
import {
  SendIcon, SunIcon, HomeIcon, MusicIcon, BoltIcon,
  HeartIcon, BookIcon, ChartIcon,
} from './icons.jsx';

const LONG_PLACEHOLDER = '描述你想做的事，例如「用今天最热的话题写一篇爆款文章」';
const SHORT_PLACEHOLDER = '说说你想做什么…';

const CHIPS = [
  { icon: <SunIcon size={13} />, label: '看看今天热点', text: '帮我看看今天微博和抖音有什么热点' },
  { icon: <HomeIcon size={13} />, label: '爆款风格', text: '用最热的话题生成一篇爆款文章' },
  { icon: <MusicIcon size={13} />, label: '诗意叙事风', text: '用诗意叙事风格写一篇情感文章' },
  { icon: <BoltIcon size={13} />, label: '观点犀利风', text: '用观点犀利风格写一篇热点评论' },
  { icon: <HeartIcon size={13} />, label: '治愈温暖风', text: '用治愈温暖风格写一篇生活感悟' },
  { icon: <BookIcon size={13} />, label: '干货科普风', text: '用干货科普风格写一篇知识科普' },
  { icon: <ChartIcon size={13} />, label: '系统状态', text: '查看系统运行状态' },
];

/**
 * 底部输入区:快捷问题 chips + 输入框 + 发送按钮。
 * inputRef 由父级持有,用来在发送完成后按需聚焦(触屏不抢焦点)。
 */
export default function Composer({ busy, device, onSend, inputRef }) {
  const [draft, setDraft] = useState('');
  const boxRef = useRef(null);

  const autoResize = (el) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 148) + 'px';
  };

  const submit = () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft('');
    const el = inputRef?.current;
    if (el) el.style.height = 'auto';
    onSend(text);
  };

  const handleKeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <footer className="composer-wrap">
      <div className="composer">
        <div className="chips">
          {CHIPS.map((c) => (
            <button className="chip" key={c.label} disabled={busy} onClick={() => onSend(c.text)}>
              {c.icon}
              {c.label}
            </button>
          ))}
        </div>

        <div className="composer-box" ref={boxRef}>
          <textarea
            id="messageInput"
            ref={inputRef}
            rows={1}
            placeholder={device === 'mobile' ? SHORT_PLACEHOLDER : LONG_PLACEHOLDER}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); autoResize(e.target); }}
            onKeyDown={handleKeydown}
          />
          <button className="btn-send" disabled={busy} onClick={submit}>
            <SendIcon size={15} />
            发送
          </button>
        </div>

        <div className="composer-hint">
          <kbd>Enter</kbd> 发送 · <kbd>Shift</kbd> + <kbd>Enter</kbd> 换行
        </div>
      </div>
    </footer>
  );
}
