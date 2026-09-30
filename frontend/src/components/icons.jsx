/**
 * 图标组件。全部沿用旧版内联 SVG 的路径,stroke 继承 currentColor。
 * size 为渲染尺寸(px),viewBox 统一 24。
 */

function Svg({ size = 24, strokeWidth = 2, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** 品牌对话气泡(顶栏 logo / 消息头像 / 登录页品牌) */
export function AgentIcon(props) {
  return (
    <Svg {...props}>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.2 9.2 0 0 1-3.2-.6L3 21l1.8-5a8.1 8.1 0 0 1-.8-3.5 8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8 8.4Z" />
      <path d="M8.5 11h7M8.5 14.5h4" />
    </Svg>
  );
}

/** 回到最新(向下箭头) */
export function ArrowDownIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </Svg>
  );
}

/** 对勾(步骤卡片头部 / 登录页特性列表) */
export function CheckIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 12.5 9 17.5 20 6.5" />
    </Svg>
  );
}

/** 思考步骤(灯泡) */
export function ThoughtIcon(props) {
  return (
    <Svg {...props}>
      <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.3.3.5.7.5 1.1h6c0-.4.2-.8.5-1.1A6 6 0 0 0 12 3Z" />
    </Svg>
  );
}

/** 工具调用(扳手) */
export function ToolCallIcon(props) {
  return (
    <Svg {...props}>
      <path d="M14.7 6.3a4 4 0 0 0 5 5L21 21l-3 0-9.7-9.7a4 4 0 0 1-5-5l2.4 2.4 2.3-2.3L5.6 4a4 4 0 0 1 5 5Z" />
    </Svg>
  );
}

/** 工具结果(小对勾) */
export function ToolResultIcon(props) {
  return <CheckIcon strokeWidth={2.6} {...props} />;
}

/** 发送按钮(右箭头) */
export function SendIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 12h15M13 6l6 6-6 6" />
    </Svg>
  );
}

/** 快捷问题:看看今天热点(太阳) */
export function SunIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </Svg>
  );
}

/** 快捷问题:爆款风格(房子) */
export function HomeIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 20h16M6 20V9l6-5 6 5v11" />
    </Svg>
  );
}

/** 快捷问题:诗意叙事风(音符) */
export function MusicIcon(props) {
  return (
    <Svg {...props}>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </Svg>
  );
}

/** 快捷问题:观点犀利风(闪电) */
export function BoltIcon(props) {
  return (
    <Svg {...props}>
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
    </Svg>
  );
}

/** 快捷问题:治愈温暖风(爱心) */
export function HeartIcon(props) {
  return (
    <Svg {...props}>
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21.2l7.8-7.8 1-1a5.5 5.5 0 0 0 0-7.8Z" />
    </Svg>
  );
}

/** 快捷问题:干货科普风(书) */
export function BookIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
    </Svg>
  );
}

/** 快捷问题:系统状态(柱状图) */
export function ChartIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 19V5M9 19v-7M14 19V9M19 19v-4" />
    </Svg>
  );
}

/** 欢迎卡片:智能内容创作(笔) */
export function PenIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </Svg>
  );
}

/** 欢迎卡片:一键发布(下载) */
export function DownloadIcon(props) {
  return (
    <Svg {...props}>
      <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
    </Svg>
  );
}

/** 登录页:账号(用户) */
export function UserIcon(props) {
  return (
    <Svg {...props}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Svg>
  );
}

/** 登录页:密码(锁) */
export function LockIcon(props) {
  return (
    <Svg {...props}>
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </Svg>
  );
}

/** 登录页:显示密码(睁眼) */
export function EyeIcon(props) {
  return (
    <Svg {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  );
}

/** 登录页:隐藏密码(闭眼) */
export function EyeOffIcon(props) {
  return (
    <Svg {...props}>
      <path d="M4 4l16 16" />
      <path d="M9.9 5.9A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6M6.4 7.9A17 17 0 0 0 2.5 12S6 18.5 12 18.5c1.1 0 2.1-.2 3-.5" />
    </Svg>
  );
}

/** 登录页:错误提示(警告) */
export function AlertIcon(props) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.2v.1" />
    </Svg>
  );
}

/** 执行步骤图标映射(与原版 ICON 一致) */
export const STEP_ICONS = {
  thought: <ThoughtIcon size={11} strokeWidth={2.2} />,
  tool_call: <ToolCallIcon size={11} strokeWidth={2.2} />,
  tool_result: <ToolResultIcon size={11} />,
};
