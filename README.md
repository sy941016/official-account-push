# AI Agent 公众号内容助手

基于 ReAct 架构的自动化内容生产 Agent。以自然语言下达指令，Agent 自主规划并调用工具完成：爬取热点（微博 / 抖音）→ AI 生成文章（五种风格）→ 自动配图 → 推送微信公众号草稿箱 → 飞书反馈。

## 功能特性

- **热点采集**：微博热搜、抖音热榜，三级备用策略（官方 API → 第三方接口 → 网页解析），识别爆点并输出跨平台可比的热度分
- **文章生成**：五种风格（爆款 / 诗意叙事 / 观点犀利 / 治愈温暖 / 干货科普），内置反 AI 检测三层机制（提示词节奏控制 → 后处理 → 自检重写）
- **自动配图**：按内容关键词从 Unsplash / Pexels 搜图，插入正文并作为封面；所有失败路径静默降级，不阻断发布
- **多端交互**：Web 聊天界面（React + Vite，支持登录鉴权）、飞书机器人（长连接 / HTTP 回调两种模式）
- **定时任务**：按 Cron 表达式自动执行完整流水线，支持试运行（`--dry-run`，无外部副作用）

## 快速开始

要求 Node.js >= 18。

```bash
npm install
cp .env.example .env   # 填入 API Key（见下方配置）
npm run build:web      # 首次运行需构建前端
npm start              # 飞书 + Web + 定时任务（推荐日常使用）
# 或
npm run web            # 仅 Web 聊天界面，http://localhost:3000
```

开发模式（前端热更新）：

```bash
npm run dev            # 后端 3000 + Vite 5173，访问 http://localhost:5173
npm test               # 单元测试
```

## 运行模式

| 命令 | 定时推送 | 说明 |
|------|:---:|------|
| `npm start` | ✅ | 定时 + 飞书长连接 + Web（推荐） |
| `npm run server` | ✅ | 定时 + 飞书 HTTP 回调 + Web（需内网穿透） |
| `npm run scheduler` | ✅ | 仅定时任务 |
| `npm run web` | ❌ | 仅 Web 聊天界面 |
| `npm run once` | ❌ | 执行一次完整流水线 |
| `npm run dry-run` | ❌ | 试运行：完整爬取 + 生成，不推送、不通知、不写去重缓存 |

首次验证链路建议用 `npm run dry-run`；定时任务同样支持试运行：`node src/main.js --mode=scheduler --dry-run`。

## 环境变量

编辑项目根目录 `.env`（模板见 `.env.example`）。

### AI（至少配置一家）

| 变量 | 说明 |
|------|------|
| `AI_PROVIDER` | `claude` / `openai` / `doubao` |
| `ANTHROPIC_API_KEY` | Claude API Key |
| `OPENAI_API_KEY` | OpenAI API Key |
| `DOUBAO_API_KEY` | 豆包 API Key |
| `DOUBAO_MODEL` | 豆包模型 ID（推荐用非推理模型，见下文） |

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | — | 公众号凭证，不配则跳过发布 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_CHAT_ID` | — | 飞书应用凭证与通知群 |
| `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` | — | HTTP 回调模式的事件鉴权 / 加密 |
| `WEIBO_COOKIE` / `DOUYIN_COOKIE` | — | 提升爬取成功率 |
| `IMAGE_PROVIDER` | `unsplash` | 图库：`unsplash` / `pexels` / `none`（关闭配图） |
| `UNSPLASH_ACCESS_KEY` / `PEXELS_API_KEY` | — | 图库 Key，不配则跳过配图 |
| `IMAGE_COUNT` / `IMAGE_AS_COVER` | `2` / `true` | 正文配图数量；首图是否兼作封面（占素材库配额） |
| `CRON_SCHEDULE` | `0 */2 * * *` | 定时任务表达式 |
| `TOPICS_PER_RUN` / `TOPIC_INTERVAL_SECONDS` | `3` / `5` | 每次处理热点数；话题间隔 |
| `ARTICLE_STYLE` | `default` | 默认风格：`default` / `jaychou` / `sharp` / `healing` / `knowledge` |
| `ARTICLE_TEMPERATURE` / `ARTICLE_MAX_TOKENS` | `0.9` / `4096` | 采样温度；单次最大输出 |
| `ARTICLE_HUMANIZE` | `true` | 去 AI 味后处理 |
| `ARTICLE_MIN_HUMAN_SCORE` / `ARTICLE_REWRITE_ROUNDS` | `70` / `1` | 自检分阈值；重写轮数 |
| `ARTICLE_TOTAL_BUDGET_MS` | `600000` | 单篇文章总时间预算（覆盖重试 + 重写） |
| `AI_REQUEST_TIMEOUT_MS` / `AI_MAX_RETRIES` | `180000` / `3` | 单次 AI 请求超时 / 重试次数 |
| `AGENT_MAX_ITERATIONS` / `AGENT_MEMORY_SIZE` | `10` / `20` | Agent 最大推理轮次；会话消息窗口 |
| `AGENT_WEB_PORT` | `3000` | Web 服务端口 |
| `WEB_LOGIN_USER` / `WEB_LOGIN_PASSWORD` | 空 | 同时配置才启用登录页 |
| `WEB_SESSION_TTL_HOURS` / `WEB_SESSION_SECRET` | `12` / 空 | 会话有效期；cookie 签名密钥 |
| `WEB_ACCESS_TOKEN` | 空 | 设置后调用 `/api/*` 需带 `x-web-token` 头 |
| `WEB_CORS_ORIGIN` | `*` | 允许的跨域来源 |
| `LOG_LEVEL` / `LOG_MAX_SIZE_MB` / `LOG_MAX_FILES` | `info` / `10` / `7` | 日志级别与轮转 |

### 推理模型注意事项

`DOUBAO_MODEL` 使用推理模型（如 `doubao-seed-evolving`）时需调整两个参数：

- 推理模型吞吐约 20~25 token/s，实测单篇 1800 字文章耗时 260s，需将 `AI_REQUEST_TIMEOUT_MS` 调至 `600000`
- `reasoning_tokens` 计入 `max_tokens`，需将 `ARTICLE_MAX_TOKENS` 调至 `8192`

非推理模型无此问题。截断的选题会被跳过且不写入去重缓存，下一轮自动重试。

## 凭证获取

| 凭证 | 获取方式 |
|------|---------|
| Claude / OpenAI / 豆包 Key | 对应平台控制台创建 API Key；豆包 `DOUBAO_MODEL` 填推理接入点 ID（`ep-` 开头） |
| 公众号凭证 | mp.weixin.qq.com → 设置与开发 → 基本配置；需将服务器 IP 加入白名单，素材库至少保留一张图（封面兜底） |
| Unsplash / Pexels Key | 官网开发者页注册即得，免费额度，二者选一即可 |
| 飞书应用 | open.feishu.cn 创建企业自建应用，开通 `im:message` 权限，事件订阅选长连接模式并添加 `im.message.receive_v1` |

## Web 登录

`.env` 中同时配置 `WEB_LOGIN_USER` / `WEB_LOGIN_PASSWORD` 即启用登录页。实现要点：

- 签名会话 cookie（HttpOnly + SameSite=Lax），有效期由 `WEB_SESSION_TTL_HOURS` 控制
- 登录失败按 IP 限流（5 分钟错 5 次封锁 5 分钟）
- 未登录访问 `/api/*` 返回 401（`loginRequired: true`），前端据此跳登录页
- 修改 `WEB_LOGIN_*` 后需重启服务

## 反 AI 检测

腾讯朱雀等 AIGC 检测器判定的是统计分布（困惑度、结构规律性、词汇分布），而非字面用词。本项目采用三层机制：

1. **提示词层**：正向节奏范文 + 可程序检查的量化硬指标
2. **后处理层**：套话替换 + 长段落随机打散（随机数由内容哈希派生，打分确定性）
3. **自检层**：本地按同指标打分，低于阈值则带问题清单重写，取分高者

自检 CLI（`npm run score`）：

```bash
npm run score -- article.html          # 读文件
npm run score -- --text "要检测的文字"  # 直接传文本
cat article.html | npm run score       # 标准输入
npm run score -- article.html --json   # JSON 输出
```

> 自检分是统计近似值，不等于检测平台真实输出，最终以朱雀实测为准；它也不校验内容真实性——生成时会列出无法从话题输入溯源的数字与引语（`article.untraceableSpecifics`），发布前建议人工核对。

## 项目结构

```
config/index.js            # 配置聚合 + 启动期校验
frontend/                  # 前端工程（React + Vite）
  vite.config.js           # 产物输出到 src/server/public/dist，dev 代理 /api 到 3000
  src/                     # 入口、页面（Chat/Login）、组件、样式
src/
  agent/                   # ReAct 循环、工具注册表、对话记忆、系统提示词
  server/                  # Web HTTP 服务（鉴权 + API + 伺服前端产物）
  feishu/                  # 飞书消息发送、WebSocket / HTTP 回调接入
  crawlers/                # 微博 / 抖音热点爬虫
  ai/                      # 统一 AI 调用层、文章生成、去 AI 味后处理
  images/provider.js       # 图库搜图与下载
  wechat/publisher.js      # 公众号草稿箱推送
  utils/                   # 日志、去重缓存、通用工具
  main.js                  # 主入口（模式分发、流水线、定时任务）
scripts/score.js           # 人味自检 CLI
test/                      # 单元测试（node --test，本地 mock，无外部依赖）
```

## 安全提示

- `.env` 已被 gitignore，请勿提交；若曾提交，需在对应平台轮换密钥
- HTTP 回调模式（`npm run server`）务必配置 `FEISHU_VERIFICATION_TOKEN`
- 登录页是访问控制而非完整账户体系；暴露公网时请加 HTTPS 并配置 `WEB_SESSION_SECRET`
- Web 服务默认监听 `0.0.0.0`，仅本机使用时可将 `WEB_CORS_ORIGIN` 收窄

## 常见问题

**爬取失败**：三级备用策略自动降级；配置 `WEIBO_COOKIE` 可明显提升成功率。

**文章没有配图**：配图全链路降级不阻断发布。检查图库 Key 是否配置、`IMAGE_PROVIDER` 是否有效；正文插图依赖公众号凭证（需上传微信 CDN）。

**草稿创建失败（封面 media_id 缺失）**：封面为硬依赖，检查公众号凭证、素材库是否有图、素材库配额是否用尽（`IMAGE_AS_COVER=true` 时每篇占用一张）。

**`npm run scheduler` 秒退**：Cron 表达式无效时进程静默退出，检查日志中的「Cron表达式无效」一行。

**多用户**：飞书按群、Web 按浏览器会话隔离对话记忆，最多保留 500 个会话（LRU 淘汰）。

**日志位置**：`logs/YYYY-MM-DD.log`，超 `LOG_MAX_SIZE_MB` 自动轮转，保留 `LOG_MAX_FILES` 份。
