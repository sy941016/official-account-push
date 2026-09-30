import { Fragment } from 'react';

/**
 * 极简 Markdown 渲染,输出 React 元素。
 * 与原版实现保持一致的语法覆盖:h3 / hr / blockquote / ul / ol / code block,
 * 行内 code / **strong** / *em* / [链接](https://...)。
 * 文本一律走 JSX 文本节点渲染,React 自动转义,天然没有 XSS 入口。
 */

let keySeq = 0;
const nextKey = () => `md-${keySeq++}`;

/** 对节点数组中的字符串依次应用行内替换,元素节点原样保留 */
function transform(nodes, regex, render) {
  const out = [];
  for (const node of nodes) {
    if (typeof node !== 'string') { out.push(node); continue; }
    let last = 0;
    let m;
    const re = new RegExp(regex.source, 'g');
    while ((m = re.exec(node))) {
      if (m.index > last) out.push(node.slice(last, m.index));
      out.push(render(m));
      last = m.index + m[0].length;
    }
    if (last < node.length) out.push(node.slice(last));
  }
  return out;
}

function renderInline(text) {
  // 替换顺序与原版一致:code → strong → em → link
  let nodes = [text];
  nodes = transform(nodes, /`([^`]+)`/g, (m) => <code key={nextKey()}>{m[1]}</code>);
  nodes = transform(nodes, /\*\*([^*]+)\*\*/g, (m) => <strong key={nextKey()}>{m[1]}</strong>);
  nodes = transform(nodes, /(^|[^*])\*([^*\n]+)\*/g, (m) => (
    <Fragment key={nextKey()}>{m[1]}<em>{m[2]}</em></Fragment>
  ));
  nodes = transform(nodes, /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (m) => (
    <a key={nextKey()} href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>
  ));
  return nodes;
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').split('\n');
  const blocks = [];
  let listType = null; // 'ul' | 'ol' | null
  let listItems = [];
  let inCode = false;
  let codeBuf = [];

  const closeList = () => {
    if (!listType) return;
    const List = listType;
    blocks.push(<List key={nextKey()}>{listItems}</List>);
    listType = null;
    listItems = [];
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');

    if (/^\s*```/.test(line)) {
      if (inCode) {
        blocks.push(<pre key={nextKey()}><code>{codeBuf.join('\n')}</code></pre>);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeBuf.push(raw); continue; }

    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      closeList();
      blocks.push(<h3 key={nextKey()}>{renderInline(heading[1])}</h3>);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/.test(line)) {
      closeList();
      blocks.push(<hr key={nextKey()} />);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      blocks.push(<blockquote key={nextKey()}>{renderInline(quote[1])}</blockquote>);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (listType !== 'ul') { closeList(); listType = 'ul'; }
      listItems.push(<li key={nextKey()}>{renderInline(bullet[1])}</li>);
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (listType !== 'ol') { closeList(); listType = 'ol'; }
      listItems.push(<li key={nextKey()}>{renderInline(ordered[1])}</li>);
      continue;
    }

    if (!line.trim()) { closeList(); continue; }

    closeList();
    blocks.push(<p key={nextKey()}>{renderInline(line)}</p>);
  }

  if (inCode) blocks.push(<pre key={nextKey()}><code>{codeBuf.join('\n')}</code></pre>);
  closeList();
  return blocks;
}
