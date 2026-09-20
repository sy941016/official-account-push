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

**登录页**：在 `.env` 里配好 `WEB_LOGIN_USER` / `WEB_LOGIN_PASSWORD` 后，访问任何页面都会先跳到
`/login`；登录成功才进入助手页，顶栏会显示当前账号并提供「退出登录」。
两个变量**都留空则不启用登录**，行为与加登录之前完全一致。

几个实现细节，排查时用得上：

- 会话是一枚签名 cookie（`oap_session`，HttpOnly + SameSite=Lax），**没有引入任何新依赖**；
  payload 里只有用户名和过期时间，不含密码。有效期由 `WEB_SESSION_TTL_HOURS` 控制（默认 12 小时）。
- 勾掉「记住我」下发的是**会话 cookie**（关掉浏览器即失效），勾上才带 `Max-Age`。
- 登录失败按来源 IP 限流：5 分钟内错 5 次封锁 5 分钟，返回 `429`。计数在内存里，重启即清零。
- 账号和密码只配了一个时**不会启用登录**（只打一条启动警告）——这种"设置了但没生效"不报错不警告，
  所以特意在 `validateConfig()` 里点了出来。
- 改完 `WEB_LOGIN_*` **必须重启服务**：配置是模块加载时读的，老进程会静默沿用旧账号密码。
- 接口未登录时返回 `401` 且响应体带 `loginRequired: true`，前端据此跳登录页；
  这和 `WEB_ACCESS_TOKEN` 那个 401 是两回事，别混。

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
    server.js              # Web 聊天 HTTP 服务（含登录路由与鉴权守卫）
    auth.js                # 登录鉴权（签名会话 cookie、失败限流）
    public/login.html      # 登录页
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
    generator.js           # AI 文章生成（双风格 + 反 AI 检测提示词 + 自检重写）
    humanize.js            # 去AI味后处理 + "人味"体检打分
  images/
    provider.js            # 图库搜图 + 下载（Unsplash / Pexels，失败一律降级不阻断）
  wechat/
    publisher.js           # 公众号草稿箱推送（正文配图上传 + 封面）
  utils/
    logger.js              # 日志（异步写入 + 按大小轮转）
    cache.js               # 去重缓存、爆点评分
    helpers.js             # 通用工具（重试、请求体读取、去重、正文插图等）
  main.js                  # 主入口
scripts/
  score.js                 # 人味自检 CLI（npm run score）
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

## 怎么提高"人工特征占比"（反 AI 检测）

腾讯朱雀这类 AIGC 检测器会给一个"人工特征占比"。要提这个数，先得理解它在测什么：

**它测的是统计分布，不是字面用词。** 主要三个维度：

| 维度 | AI 文本的表现 | 人写的表现 |
|------|---------------|-----------|
| 困惑度（用词可预测性） | 每步都挑概率最高的词，读起来"太顺" | 有思维跳跃、有不太常规的搭配 |
| 结构规律性 | 段落等长、句式工整、过渡顺滑 | 忽长忽短，偶尔潦草 |
| 词汇分布 | 高频套话和模板连接词密集 | 套话少，口语词多 |

所以**「把『首先』改成『第一个方面』、把『因此』换成『所以』完全没用」**——分布没变，照样被识别。
本项目用三层来提这个数：

1. **提示词层（主力）**。`src/ai/generator.js` 给模型一段正向的**节奏范文**，外加一组
   可被程序检查的量化硬指标（句长变异系数、短句/长句占比、单句成段数、具体细节密度、禁止排比……）。
   范文比禁用词表有效得多：禁用词表只说"别写什么"，范文告诉模型"该是什么节奏"。
2. **后处理层**。`src/ai/humanize.js` 清理高频套话，并把过长的段落从句子边界切开，
   制造段落长短悬殊。切分带随机性——如果每个长段都按同一规则切，本身又会变成一种新规律。
3. **自检层**。生成后按同样的指标本地打分，低于阈值就带着问题清单让模型重写一轮，
   最终取分高的那一版（`ARTICLE_REWRITE_ROUNDS` 控制轮数，这是唯一的额外成本）。

想手工验证某篇文章，用自检 CLI：

```bash
npm run score -- article.html         # 读文件（HTML 或纯文本都行）
npm run score -- --text "要检测的文字"
cat article.html | npm run score      # 从标准输入
npm run score -- article.html --json  # 输出 JSON，方便脚本消费
```

它会打印人味分、各维度得分条、关键指标与目标值对比，以及一份问题清单。

**打分是确定性的**：同一段文字跑多少次，得分都完全一致，改一个字才会变。
（段落打散的随机数由**内容哈希**派生，而不是系统随机数。用真随机的话，同一篇文章
每次跑分都不一样——实测抖动可达 7 分——那把尺子就没法判断"改这一版到底是变好还是变差"了。）

> ⚠️ 自检分是**代理指标**——按检测器公开的原理做的统计近似，不等于朱雀的真实输出。
> 它的价值是让优化有可比的反馈，不用每次都去检测平台点一遍。**最终以朱雀的实际检测为准。**
>
> 另外，AI 率只是平台限流的一个因素。同质化程度、选题吸引力同样影响推荐，
> 通过检测不代表内容一定有人看。

> ⚠️ **自检分不检查内容真假，别把它当成质量分。**
> "具体细节密度"这一项数的是**数字和引号出现了几次**，不验证这些数字是不是真的。
> 一篇编造了大量假数据的文章，这一项照样能拿满分——**高分不等于可以发**。
>
> 这个漏洞真的被踩到过：热搜接口不提供背景，输入只有"标题 + 热度"，
> 而提示词却要求"至少 3 处具体到不能编造的细节"。模型为了达标，编出了精确到分钟的时间、
> 具体的售价与维修报价，还把虚构的引语安到了真实博主头上，而该项拿了满分。
> 现在提示词已明确「具体 ≠ 编造」，并允许"凑不够就少写几处"。
>
> **生成时会打一条 warn，列出"无法从话题输入溯源"的数字和引语**（正文里有、输入里没有），
> 形如：`正文有 15 处具体信息无法从话题输入溯源（8 / 07 / 12999 / …）——建议核对`。
> 它**不判定造假**——文章引用真实的公共事实（历史事件、已知产品售价）同样会被列出来——
> 但把核对范围从"读完整篇"缩小到"看这几个词"。这个列表在 `article.untraceableSpecifics` 里。
>
> **发布前仍建议人工核对文中的数字、价格和引号里的话。**
>
> 要根治这一点，得让输入真正带上背景（抓取话题相关的原文），而不是靠提示词约束模型别乱写。

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
| `ARTICLE_TEMPERATURE` | 生成采样温度。反检测靠句式多样性，调低会让表达更"标准" | `0.9` |
| `ARTICLE_MAX_TOKENS` | 单次生成的最大输出 token，文章长/被截断时调高 | `4096` |
| `ARTICLE_HUMANIZE` | 生成后是否做去 AI 味后处理（套话替换 + 长段落打散） | `true` |
| `ARTICLE_MIN_HUMAN_SCORE` | 人味自检分低于此值时带问题清单重写，`0` = 从不重写 | `70` |
| `ARTICLE_REWRITE_ROUNDS` | 最多重写几轮（每轮多一次模型调用），`0` = 关闭 | `1` |
| `ARTICLE_TOTAL_BUDGET_MS` | **单篇文章的总时间预算**，覆盖重试+重写全部环节，超预算不再开新一轮 | `600000` |
| `AI_FREQUENCY_PENALTY` | 压低高频词重复率（仅 openai / doubao 生效） | `0.4` |
| `AI_PRESENCE_PENALTY` | 鼓励引入新词（仅 openai / doubao 生效） | `0.3` |
| `AGENT_WEB_PORT` | Web 聊天端口 | `3000` |
| `AGENT_MAX_ITERATIONS` | Agent 最大推理轮次 | `10` |
| `AGENT_MEMORY_SIZE` | 每个会话保留消息数（建议 ≥ 8） | `20` |
| `AGENT_MAX_TOOL_RESULT_CHARS` | 单条工具结果写入上下文的截断长度 | `8000` |
| `WEB_CORS_ORIGIN` | Web 服务允许的跨域来源 | `*` |
| `WEB_ACCESS_TOKEN` | 设置后调用 `/api/*` 需带 `x-web-token` 头 | 空（不校验） |
| `WEB_LOGIN_USER` | Web 登录账号，与下一项**同时**配置才启用登录页 | 空（不启用） |
| `WEB_LOGIN_PASSWORD` | Web 登录密码 | 空（不启用） |
| `WEB_SESSION_TTL_HOURS` | 登录有效期（小时），下限 5 分钟 | `12` |
| `WEB_SESSION_SECRET` | 会话 cookie 签名密钥，留空则由账号密码派生 | 空 |
| `AI_REQUEST_TIMEOUT_MS` | 单次 AI 请求超时 | `180000` |
| `AI_MAX_RETRIES` | AI 调用失败重试次数 | `3` |
| `CRAWLER_TIMEOUT_MS` | 爬虫请求超时 | `15000` |
| `MAX_BODY_BYTES` | HTTP 请求体大小上限 | `1000000` |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` | `info` |
| `LOG_MAX_SIZE_MB` | 单个日志文件大小上限，超出自动轮转 | `10` |
| `LOG_MAX_FILES` | 日志文件保留份数 | `7` |

### 用推理模型时必看（`doubao-seed-evolving` 等）

如果 `DOUBAO_MODEL` 填的是**推理模型**，有两个坑必须调参数，否则表现就是"生成老是失败"：

| 现象 | 原因 | 怎么办 |
|------|------|--------|
| `timeout of 180000ms exceeded`，然后反复重试 | 推理模型吞吐只有 20~25 token/秒。**实测生成一篇 1778 字的文章耗时 260 秒**，超过默认的 180 秒 | `AI_REQUEST_TIMEOUT_MS` 调到 `600000` |
| 报错 `模型输出被截断（max_tokens=… 不够用）` | **`reasoning_tokens` 也计入 `max_tokens`**，思维链越长，留给正文的额度越少 | `ARTICLE_MAX_TOKENS` 调大（如 `8192`） |

> 上面两条**都会踩到**，不是理论风险：
> 超时是必然的（实测一篇 1800~2300 字的文章要 160~260 秒，超过默认的 180 秒）；
> 截断在 `ARTICLE_MAX_TOKENS=4096` 下的实测失败率是 **4 次里挂 1 次**，调到 `8192` 后未再出现。
>
> 被截断的选题会被跳过并重试（不写入去重缓存），但那一轮就少一篇文章，
> 定时任务下会表现为"偶尔少发"。所以这两个参数建议直接照上面调好。

> **补充一个实测提醒：`600000` 也不是绝对够。** 有一次端到端跑批，
> 单次调用真的**撞满了 600 秒**才超时，随后自动重试、第二次 292 秒成功——
> 说明单次调用耗时**有 >600 秒的长尾**（不是每次，但会发生）。
>
> 所以保留 600 秒、靠重试兜底，而不是继续调大单次超时。但**光靠重试有个更严重的隐患**：
> 超时是按**单次请求**计的，而最坏耗时是它的连乘——
> `AI_REQUEST_TIMEOUT_MS`(600s) × (`AI_MAX_RETRIES`+1 = 4) × (重写轮次+1 = 2) = **80 分钟/篇**。
> 流水线是**串行**的（`runPipeline` 里逐条 `await processTopic`），调度周期只有 12 小时，
> 一篇卡住的文章会把后面所有话题一起挤掉。
>
> 因此加了 `ARTICLE_TOTAL_BUDGET_MS`：它是**整篇文章**的硬上限，无论重试和重写怎么叠加都不会超过。
> 超预算时不再开新一轮重写，手里已有的版本照常返回；一轮都没成功才返回 `null` 跳过该选题。
> 注意预算只能拦住"**要不要开始**下一次尝试"，拦不住正在进行中的那一次，
> 所以真实最坏耗时 ≈ `ARTICLE_TOTAL_BUDGET_MS` + `AI_REQUEST_TIMEOUT_MS`（本机设 900s 时约 25 分钟）。
>
> **另一个实测结论：不要为了省时间把多个话题并发生成。** 同一接口单次真实负载约 68 秒，
> 但 4 路并发时 4 次全部撞满超时（0/4 成功）。生产代码本来就是串行的，别改成 `Promise.all`。
>
> 另外，**重写轮超时不会丢掉已经生成的那一版**：任何一轮出错都会保留目前分最高的版本继续走完；
> 如果从头到尾都失败，该选题返回 `null` 被跳过，不会把半成品推进草稿箱。

> 截断是**硬失败**，不是警告。响应被切断时返回的 JSON 一定是残缺的，
> 代码会检测到并**跳过该选题**（不会把半成品推进草稿箱）；
> 失败的选题也不会写入去重缓存，下一轮会自动重试。

**嫌麻烦的话**，把 `DOUBAO_MODEL` 换成非推理模型即可：这类模型不产出思维链，
同样篇幅通常十几秒就写完，`4096` 的额度也够用。

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
- 登录页只是**一层访问控制**，不是完整的账户体系：口令明文存在 `.env` 里、没有找回流程、会话 cookie 也不带 `Secure`
  （本地是 http，带上会被浏览器直接丢弃）。要暴露到公网，请在反向代理上加 HTTPS 并配置 `WEB_SESSION_SECRET`。

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
