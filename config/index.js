import 'dotenv/config';

export const config = {
  // AI
  ai: {
    provider: process.env.AI_PROVIDER || 'claude',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
    openaiKey: process.env.OPENAI_API_KEY || '',
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4o',
    doubaoKey: process.env.DOUBAO_API_KEY || '',
    doubaoModel: process.env.DOUBAO_MODEL || 'doubao-pro-1-5',
  },

  // 微信公众号
  wechat: {
    appId: process.env.WECHAT_APP_ID || '',
    appSecret: process.env.WECHAT_APP_SECRET || '',
    apiBase: 'https://api.weixin.qq.com',
  },

  // 飞书
  feishu: {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
    chatId: process.env.FEISHU_CHAT_ID || '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN || '',
    encryptKey: process.env.FEISHU_ENCRYPT_KEY || '',
    apiBase: 'https://open.feishu.cn/open-apis',
  },

  // 图片服务
  image: {
    provider: process.env.IMAGE_PROVIDER || 'unsplash',
    unsplashKey: process.env.UNSPLASH_ACCESS_KEY || '',
    pexelsKey: process.env.PEXELS_API_KEY || '',
  },

  // 爬虫
  crawler: {
    weiboUrl: 'https://weibo.com/ajax/side/hotSearch',
    douyinUrl: 'https://www.douyin.com/aweme/v1/web/hot/search/list/',
    weiboBackupUrl: 'https://s.weibo.com/top/summary',
    weiboFallbackUrl: 'https://tenapi.cn/v2/weibohot',  // 第三方接口备用
    weiboCookie: process.env.WEIBO_COOKIE || '',
    douyinCookie: process.env.DOUYIN_COOKIE || '',
  },

  // 运行
  run: {
    cronSchedule: process.env.CRON_SCHEDULE || '0 */2 * * *',
    topicsPerRun: parseInt(process.env.TOPICS_PER_RUN || '3', 10),
    localServerPort: parseInt(process.env.LOCAL_SERVER_PORT || '8080', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  },

  // 通用请求头
  defaultHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },

  // 缓存文件
  cacheFile: '.cache/processed_topics.json',
  tokenCacheFile: '.cache/wechat_token.json',
  imageCacheDir: '.cache/images',
};

export default config;
