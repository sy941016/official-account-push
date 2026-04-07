# 🤖 热点内容自动化发布系统（Node.js）

> 微博/抖音热点 → AI 生成文章 → 推送公众号草稿箱 → 飞书机器人通知

## 📁 项目结构

```
official-account-push/
├── config/
│   └── index.js              # 统一配置（读取 .env）
├── src/
│   ├── crawlers/
│   │   ├── weibo.js          # 微博热搜爬虫（3级备用策略）
│   │   └── douyin.js         # 抖音热点爬虫（3级备用策略）
│   ├── ai/
│   │   └── generator.js      # AI文章生成（Claude / OpenAI）
│   ├── wechat/
│   │   └── publisher.js      # 公众号草稿箱推送
│   ├── feishu/
│   │   ├── app.js            # 飞书核心（Token / 卡片消息 / 指令解析）
│   │   ├── websocket.js      # 飞书WebSocket长连接（无需公网IP）
│   │   └── server.js         # 飞书本地HTTP服务（配合ngrok）
│   ├── utils/
│   │   ├── logger.js         # Winston日志（控制台+文件）
│   │   └── cache.js          # 去重缓存、关键词提取、工具函数
│   └── main.js               # 主入口（CLI参数 + 定时任务）
├── package.json
└── .env
```

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量
# 编辑 .env，填入各平台 Key

# 3. 运行
npm run once         # 执行一次（测试用）
npm run websocket    # 推荐：定时 + 飞书WebSocket
npm run server       # 定时 + 飞书HTTP服务（需ngrok）
npm run scheduler    # 仅定时任务
```

## ⚙️ 运行模式

| 命令 | 说明 | 是否需要公网IP |
|------|------|:---:|
| `npm run once` | 立即执行一次 | ❌ |
| `npm run scheduler` | 仅定时任务 | ❌ |
| `npm run websocket` | ✅ **推荐** 定时 + 飞书WebSocket | ❌ |
| `npm run server` | 定时 + 飞书HTTP回调 | ✅（需ngrok） |

## 🔧 平台配置说明

### 微信公众号
登录 [mp.weixin.qq.com](https://mp.weixin.qq.com) → 设置 → 开发者工具 → 获取 AppID/AppSecret

### 飞书自建应用
1. [open.feishu.cn](https://open.feishu.cn) → 创建企业自建应用
2. 添加权限：`im:message:send_as_bot`
3. 开启机器人功能
4. **WebSocket模式**：事件订阅 → 使用长连接 → 添加事件 `im.message.receive_v1`
5. **HTTP模式**：事件订阅 → 填入 ngrok 地址

## 🤖 飞书机器人指令

| 指令 | 效果 |
|------|------|
| `/hot` 或 `抓取热点` | 立即触发一次完整流程 |
| `/status` 或 `状态` | 查看系统运行状态卡片 |
| `/help` 或 `帮助` | 显示帮助信息 |

## 📋 工作流程

```
定时触发（Cron）
    ↓
微博热搜爬取（3级备用）+ 抖音热点爬取（3级备用）
    ↓
去重过滤（md5缓存，最近1000条）
    ↓
AI生成文章（标题/摘要/正文HTML/图片搜索词）
    ↓
默认封面图 → 创建微信草稿
    ↓
飞书机器人发送消息卡片通知
```

## 📌 常见问题

**Q: 微博爬取失败怎么办？**  
A: 系统有三级备用策略（官方API → 第三方API → 网页解析），配置 `WEIBO_COOKIE` 可提升成功率

**Q: 不想用公众号，只要飞书通知？**  
A: `.env` 中不配置 `WECHAT_APP_ID` 即可跳过公众号推送

**Q: 如何修改定时频率？**  
A: 修改 `.env` 中的 `CRON_SCHEDULE`，格式为标准 Cron 表达式，例如 `0 9,18 * * *` 表示每天9点和18点执行
