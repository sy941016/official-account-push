# AI Agent - 公众号内容助手

一个基于 ReAct（推理 + 行动）架构的 AI Agent 应用。你用自然语言告诉它想做什么，它会自主决策、调用工具完成任务：爬取热点、生成文章、发布到微信公众号，全程无需记忆固定指令。

## 它能做什么

- **采集热点** — 爬取微博热搜、抖音热榜，识别爆点话题
- **生成文章** — AI 写作，支持爆款风格和周杰伦情感风格
- **自动配图** — 按文章内容去图库（Unsplash / Pexels）搜图，插入正文并作为封面
- **自动发布** — 推送文章到微信公众号草稿箱
- **通知反馈** — 通过飞书实时汇报执行结果

你只需要用自然语言跟它对话，比如：

> "帮我看看今天微博有什么热点"
>
> "用最火的话题写一篇爆款文章，发到公众号"
>
> "用周杰伦风格写一篇关于青春的文章"

Agent 会自己规划步骤、调用工具、完成后给你汇报。

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 复制配置模板并填入 API Key（见下方配置说明）
cp .env.example .env

# 3. 启动
npm run web          # 启动 Web 聊天界面，打开 http://localhost:3000
npm run websocket    # 飞书 + Web + 定时任务（推荐日常使用）

# 4. 跑一下单元测试（可选）
npm test
```

## 运行模式

**定时推送是绑定在模式上的**，不是所有模式都有 —— 只有 `scheduler` / `websocket` / `server` 会启动定时任务：

| 命令 | 定时推送 | 说明 |
|------|:---:|------|
| `npm start` / `npm run websocket` | ✅ | 定时 + 飞书长连接 + Web 聊天（**推荐**） |
| `npm run server` | ✅ | 定时 + 飞书 HTTP 回调 + Web（需内网穿透） |
| `npm run scheduler` | ✅ | 只跑定时任务 |
| `npm run web` | ❌ | 纯聊天界面，**不会定时推** |
| `npm run once` | ❌ | 执行一次完整流水线（兼容旧模式），跑完就退出 |
| `npm run dry-run` | ❌ | **试运行**：跑完整的爬取 + 生成，但不推草稿箱、不发飞书、不写去重缓存 |

> **第一次跑建议先试运行。** `npm run once` 会真实调用 AI（产生费用）、往你的公众号草稿箱推文章、并发送飞书通知，且没有二次确认。
> 想验证链路是否通，用 `npm run dry-run` —— 它会完整走一遍爬取和文章生成，但**不产生任何外部副作用**，也不会把话题记进去重缓存（所以之后真跑不会漏掉它们）。
> 定时任务也支持试运行：`node src/main.js --mode=scheduler --dry-run`。

## 使用方式

### Web 聊天

启动后访问 `http://localhost:3000`，在对话框中输入自然语言指令。页面会展示 Agent 的思考过程和工具调用步骤。

底部有快捷按钮：「看看今天热点」「生成爆款文章」「周杰伦风格」「系统状态」。

### 飞书对话

在飞书群里 @机器人 直接说话，无需固定指令格式。Agent 会理解你的意图并执行。

飞书消息有长度限制，过长的回复会被截断。工具调用过程中会实时推送进度通知。

### 定时任务

按 `.env` 中的 `CRON_SCHEDULE` 自动执行完整的"爬取 → 生成 → 发布"流程（含封面和配图）。
可通过 `CRON_SCHEDULE=0 9,18 * * *` 自定义频率；每次处理 `TOPICS_PER_RUN` 条热点，
两条话题之间等 `TOPIC_INTERVAL_SECONDS` 秒以避免平台频控。

两个容易踩的点：

- **启动后不会立即跑一次**，要等下一个 cron 时点才触发。比如 `0 */12 * * *` 在 12:37 启动，
  下一次是 18:00。想马上验证链路用 `npm run dry-run`。
- **cron 表达式写错时进程会静默退出。** 启动期校验不检查 cron，只有定时任务注册那一步会拦；
  它只打一行「Cron表达式无效」的日志然后结束，此时没有任何定时器存活，进程随之退出。
  所以 `npm run scheduler` 如果秒退，先翻日志找这一行。

## 项目结构

```
config/
  index.js                 # 配置聚合 + 启动期校验（路径锚定项目根目录）
src/
  agent/                   # Agent 核心
    core.js                # ReAct 循环（支持 Claude / OpenAI / 豆包）
    tools.js               # 工具注册表（爬虫、生成、发布、通知等）
    memory.js              # 对话记忆（按会话隔离，裁剪时保证工具调用配对完整）
    prompts.js             # 系统提示词
  web/
    server.js              # Web 聊天 HTTP 服务
    public/index.html      # 聊天界面
  feishu/
    app.js                 # 飞书消息发送
    websocket.js           # WebSocket 长连接（推荐）
    server.js              # HTTP 回调（需内网穿透）
  crawlers/
    weibo.js               # 微博热搜（3 级备用策略）
    douyin.js              # 抖音热点（3 级备用策略）
  ai/
    client.js              # 统一 AI 调用层（Claude / OpenAI / 豆包）
    generator.js           # AI 文章生成（双风格）
  images/
    provider.js            # 图库搜图 + 下载（Unsplash / Pexels，失败一律降级不阻断）
  wechat/
    publisher.js           # 公众号草稿箱推送（正文配图上传 + 封面）
  utils/
    logger.js              # 日志（异步写入 + 按大小轮转）
    cache.js               # 去重缓存、爆点评分
    helpers.js             # 通用工具（重试、请求体读取、去重、正文插图等）
  main.js                  # 主入口
test/                      # 单元测试（node --test，无需额外依赖）
```

## 配图是怎么工作的

文章生成时 AI 会顺带给出一个英文配图关键词（`imageQuery`）。发布前：

1. 用该关键词去图库搜 `IMAGE_COUNT` 张横图并下载；
2. 上传到微信 —— **这一步不能省**。公众号正文里的 `<img>` 只认微信自己的域名，
   直接写图库的图片地址在文章里不会显示，必须换成 `media/uploadimg` 返回的微信 CDN 地址；
3. 按段落均匀插入正文（不会插在最后一段之后，也不会塞在小标题和它下面第一段之间），
   并在文末自动附上摄影师署名（Unsplash 的 API 条款要求署名 + 回链）；
4. 第一张图同时用作封面。

关于封面有两点要注意：

- 微信要求封面 `thumb_media_id` 必须是**永久素材**的 ID，所以 `IMAGE_AS_COVER=true` 时会调用
  `material/add_material` 往你的公众号**素材库上传图片**，会占用素材库配额（上限约 5000 张）。
  不想占配额就设 `IMAGE_AS_COVER=false`，封面仍取素材库第一张。
- 封面是**硬依赖**：拿不到 `thumb_media_id` 就创建不了草稿。所以配图失败时会自动退回
  「素材库第一张图」的老方案，而不是直接失败。

**配图整条链路都是"锦上添花"**：图库 Key 没配、Key 失效、搜不到图、下载失败、上传失败，
都只会退化成一篇没有配图的文章，**不会阻断发布**。想彻底关掉就把 `IMAGE_PROVIDER` 设为 `none`。

## 环境变量配置

编辑项目根目录的 `.env` 文件（可从 `.env.example` 复制）。

### 必填

| 变量 | 说明 |
|------|------|
| `AI_PROVIDER` | AI 提供商：`claude` / `openai` / `doubao` |
| `ANTHROPIC_API_KEY` | Claude API Key（provider=claude 时必填） |
| `OPENAI_API_KEY` | OpenAI API Key（provider=openai 时必填） |
| `DOUBAO_API_KEY` | 豆包 API Key（provider=doubao 时必填） |
| `DOUBAO_MODEL` | 豆包模型 ID |
| `DOUBAO_BASE_URL` | 豆包接口地址（一般不用改，用自建/代理网关时才需要） |

### 可选

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WECHAT_APP_ID` / `WECHAT_APP_SECRET` | 微信公众号凭证（不配则跳过发布） | — |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书应用凭证 | — |
| `FEISHU_CHAT_ID` | 飞书通知目标群 chat_id | — |
| `FEISHU_VERIFICATION_TOKEN` | 飞书事件校验 Token（HTTP 回调模式强烈建议配置） | — |
| `FEISHU_ENCRYPT_KEY` | 飞书事件加密 Key | — |
| `WEIBO_COOKIE` | 微博 Cookie（提升爬取成功率） | — |
| `DOUYIN_COOKIE` | 抖音 Cookie（提升爬取成功率） | — |
| `IMAGE_PROVIDER` | 图库：`unsplash` / `pexels` / `none`（关闭配图） | `unsplash` |
| `UNSPLASH_ACCESS_KEY` | Unsplash Access Key（provider=unsplash 时必填，不填则跳过配图） | — |
| `PEXELS_API_KEY` | Pexels API Key（provider=pexels 时必填） | — |
| `IMAGE_COUNT` | 每篇插入正文的配图数量，`0` = 不插图 | `2` |
| `IMAGE_AS_COVER` | 第一张配图是否同时用作封面（会占公众号素材库配额） | `true` |
| `IMAGE_REQUEST_TIMEOUT_MS` | 图库搜索/下载超时 | `15000` |
| `CRON_SCHEDULE` | 定时任务 Cron 表达式 | `0 */2 * * *` |
| `TOPICS_PER_RUN` | 每次处理热点数量 | `3` |
| `TOPIC_INTERVAL_SECONDS` | 两条话题之间的等待秒数 | `5` |
| `ARTICLE_STYLE` | 默认文章风格：`default` / `jaychou` | `default` |
| `AGENT_WEB_PORT` | Web 聊天端口 | `3000` |
| `AGENT_MAX_ITERATIONS` | Agent 最大推理轮次 | `10` |
| `AGENT_MEMORY_SIZE` | 每个会话保留消息数（建议 ≥ 8） | `20` |
| `AGENT_MAX_TOOL_RESULT_CHARS` | 单条工具结果写入上下文的截断长度 | `8000` |
| `WEB_CORS_ORIGIN` | Web 服务允许的跨域来源 | `*` |
| `WEB_ACCESS_TOKEN` | 设置后调用 `/api/*` 需带 `x-web-token` 头 | 空（不校验） |
| `AI_REQUEST_TIMEOUT_MS` | 单次 AI 请求超时 | `180000` |
| `AI_MAX_RETRIES` | AI 调用失败重试次数 | `3` |
| `CRAWLER_TIMEOUT_MS` | 爬虫请求超时 | `15000` |
| `MAX_BODY_BYTES` | HTTP 请求体大小上限 | `1000000` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `LOG_MAX_SIZE_MB` | 单个日志文件大小上限，超出自动轮转 | `10` |
| `LOG_MAX_FILES` | 日志文件保留份数 | `7` |

### 如何获取各项凭证

**新人 clone 下来时 `.env` 是不存在的**（只有 `.env.example` 模板）。下面每个值都要用**你自己的账号**去申请 —— 不要共用别人的密钥，也不要把它提交到仓库。

#### AI 模型 Key（至少配一个，否则 Agent 无法工作）

| 变量 | 去哪拿 |
|------|--------|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) → API keys |
| `DOUBAO_API_KEY` | 火山引擎方舟控制台 → API Key 管理。`DOUBAO_MODEL` 填**推理接入点 ID**（形如 `ep-xxxxxxxx`），不是模型名 |

#### 微信公众号（可选，不配则只生成文章、不发布）

1. 登录 [mp.weixin.qq.com](https://mp.weixin.qq.com)（需已认证的服务号/订阅号）
2. 设置与开发 → 基本配置 → 拿到 `AppID` 与 `AppSecret`
3. **同一页把你的服务器 IP 加入白名单**，否则调接口会报 `40164`
4. 素材库里**至少准备一张图片** —— 它是配图失败时的封面兜底方案（封面是硬依赖，没有它创建不了草稿）

#### 图库 Key（可选，不配则文章没有配图）

| 变量 | 去哪拿 |
|------|--------|
| `UNSPLASH_ACCESS_KEY` | [unsplash.com/developers](https://unsplash.com/developers) → New Application → 拿 **Access Key**（不是 Secret Key）。免费版限速 50 次/小时 |
| `PEXELS_API_KEY` | [pexels.com/api](https://www.pexels.com/api/) → 免费注册后直接给 Key |

两个都是免费额度，选一个即可（`IMAGE_PROVIDER` 指哪个就填哪个的 Key）。

#### 飞书（可选，不配则没有机器人对话与通知）

1. [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 创建**企业自建应用**
2. 凭证与基础信息 → 拿到 `AppID` / `AppSecret`
3. 权限管理 → 开通 `im:message`、`im:message:send_as_bot`
4. 事件订阅 → 选**长连接** → 添加事件 `im.message.receive_v1`
   （选长连接就不需要内网穿透，直接用 `npm run websocket`）
5. 把机器人拉进目标群；`FEISHU_CHAT_ID` 填该群的 chat_id

> 用 HTTP 回调模式（`npm run server`）时，务必把 `FEISHU_VERIFICATION_TOKEN` 也配上，否则事件接口没有鉴权保护。

#### 微博 / 抖音 Cookie（可选，但强烈建议）

浏览器登录对应站点 → F12 → Network → 随便点一个请求 → 复制请求头里的整行 `Cookie` 填进去。配置后爬取成功率会明显提升。

## 安全提示

- **`.env` 已被 `.gitignore` 忽略，请勿提交到版本库。** 如果曾经提交过，请立即在对应平台**轮换所有密钥**（仅从 Git 中移除文件并不能让已泄露的密钥失效）。
- HTTP 回调模式（`npm run server`）请务必配置 `FEISHU_VERIFICATION_TOKEN`，否则事件接口没有鉴权保护。
- Web 服务默认监听 `0.0.0.0`。仅本机使用时建议把 `WEB_CORS_ORIGIN` 收窄为 `http://localhost:3000`，需要暴露到局域网时再配置 `WEB_ACCESS_TOKEN`。

## 常见问题

**Q: 微博/抖音爬取失败？**
系统有三级备用策略（官方 API → 第三方接口 → 网页解析）。配置 `WEIBO_COOKIE` 可大幅提升成功率。

**Q: 不需要公众号发布功能？**
不配置 `WECHAT_APP_ID` 即可，Agent 会跳过发布步骤。

**Q: 文章没有配图 / 配图失败？**
先看日志里有没有 `图库搜索失败` 或 `跳过配图`。常见原因：`UNSPLASH_ACCESS_KEY` 没配、还是
`.env.example` 里的占位值（`your_unsplash_access_key`）、Key 失效、或者免费额度用完了。
**这些情况都只会让文章变成纯文字，不会导致发布失败。** 另外配图功能依赖公众号：
正文插图要上传到微信 CDN，所以 `WECHAT_APP_ID` 没配时也不会有配图。

**Q: 提示"无法获取封面图media_id，草稿创建失败"？**
封面是硬依赖，必须有 `thumb_media_id` 才能建草稿。检查：① 公众号是否配了；② 素材库里
是否有图片；③ 如果开了 `IMAGE_AS_COVER`，是否已超出素材库配额。

**Q: 为什么开了配图后公众号素材库里多了图片？**
`IMAGE_AS_COVER=true` 时会把第一张配图上传为**永久素材**（微信规定封面只能用永久素材的
`media_id`）。这确实会占用素材库配额。不想占配额就把 `IMAGE_AS_COVER` 设为 `false`，
配图只进正文，封面继续用素材库里已有的图。

**Q: Agent 跟以前的指令模式有什么区别？**
以前需要记 `/push`、`/mode` 这些固定指令，现在直接用自然语言对话，Agent 自己理解你要什么、该调哪些工具。

**Q: 支持多人同时使用吗？**
支持。飞书每个群聊、Web 每个浏览器会话都有独立的对话记忆，最多保留 500 个会话（超出按最近最少使用淘汰）。

**Q: 日志写在哪里？**
`logs/YYYY-MM-DD.log`，单文件超过 `LOG_MAX_SIZE_MB` 会自动归档为 `YYYY-MM-DD.N.log`，最多保留 `LOG_MAX_FILES` 份。

## 环境要求

- Node.js >= 18.0.0
- npm
