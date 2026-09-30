import { useEffect, useRef, useState } from 'react';
import MessageBubble from './MessageBubble.jsx';
import Welcome from './Welcome.jsx';
import StepsCard from './StepsCard.jsx';
import { ArrowDownIcon, AgentIcon } from './icons.jsx';

/** 加载态(三点跳动) */
function TypingIndicator() {
  return (
    <div className="row agent">
      <div className="avatar" aria-hidden="true"><AgentIcon size={15} /></div>
      <div className="bubble-wrap">
        <div className="bubble"><span className="typing"><i></i><i></i><i></i></span></div>
      </div>
    </div>
  );
}

/**
 * 对话滚动区。
 * items 为渲染项数组:{ kind: 'msg', role, text } / { kind: 'steps', steps } / { kind: 'notice', text }
 * scrollSignal 每次递增都会强制滚到底部(清空会话、软键盘弹出时用)。
 */
export default function MessageList({ items, isLoading, scrollSignal }) {
  const scrollRef = useRef(null);
  const [toBottomVisible, setToBottomVisible] = useState(false);

  const isNearBottom = () => {
    const el = scrollRef.current;
    return Boolean(el && el.scrollHeight - el.scrollTop - el.clientHeight < 90);
  };

  // 贴底时才自动滚动，避免用户往回翻历史时被拽走
  useEffect(() => {
    if (isNearBottom() && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [items, isLoading]);

  // 强制滚底
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [scrollSignal]);

  const handleScroll = () => setToBottomVisible(!isNearBottom());

  const handleToBottom = () => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  };

  return (
    <main className="chat-scroll" ref={scrollRef} onScroll={handleScroll}>
      <div className="chat" aria-live="polite">
        {items.length === 0 && <Welcome />}
        {items.map((item, i) => {
          if (item.kind === 'notice') {
            return <div className="notice" key={i}><span>{item.text}</span></div>;
          }
          if (item.kind === 'steps') {
            return <StepsCard steps={item.steps} key={i} />;
          }
          return <MessageBubble role={item.role} text={item.text} key={i} />;
        })}
        {isLoading && <TypingIndicator />}
      </div>
      <button
        className={'to-bottom' + (toBottomVisible ? ' show' : '')}
        onClick={handleToBottom}
        title="回到最新"
        aria-label="回到最新"
      >
        <ArrowDownIcon size={16} />
      </button>
    </main>
  );
}
