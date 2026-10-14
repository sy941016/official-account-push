/**
 * 爬虫注册表——新平台接入的唯一改动点。
 *
 * 每条记录：
 *   name        平台标识，与 topic.source 一致
 *   description 平台说明（用于生成 crawl_<name> 工具的描述）
 *   defaultTopN 默认抓取条数
 *   fetch       (topN) => Promise<Topic[]>  抓取热榜，返回标准化话题数组
 *   enrich?     (topic) => Promise<string>  可选：抓话题详情补充背景（导语 / 热门讨论），
 *                                           返回补充文本；失败必须返回空串而不是抛错
 *
 * 主流程（main.js fetchTopics）与 Agent 工具（agent/tools.js 的 crawl_<name>）
 * 都由本注册表驱动：新增平台只需实现爬虫模块并在此加一条记录。
 * 具体爬虫模块保持懒加载（fetch/enrich 内动态 import），注册表本身不引入重量级依赖。
 */
export const crawlers = [
  {
    name: 'weibo',
    description: '微博热搜榜，返回当前最热门的话题列表（含排名、热度值、爆点标签如爆/沸/热/新）',
    defaultTopN: 30,
    fetch: async (topN) => (await import('./weibo.js')).getWeiboHot(topN),
    enrich: async (topic) => (await import('./weibo.js')).fetchWeiboTopicDetail(topic),
  },
  {
    name: 'douyin',
    description: '抖音热榜，返回当前最热门的话题列表（含排名、热度值、爆点标签）',
    defaultTopN: 20,
    fetch: async (topN) => (await import('./douyin.js')).getDouyinHot(topN),
  },
];

export const crawlerMap = new Map(crawlers.map((c) => [c.name, c]));
