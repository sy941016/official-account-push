# syntax=docker/dockerfile:1

# ---------- 构建阶段：安装全部依赖（含 vite）并构建前端产物 ----------
FROM node:18-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend ./frontend
RUN npm run build:web

# ---------- 运行阶段：只装生产依赖，拷贝后端源码与前端产物 ----------
FROM node:18-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY config ./config
COPY src ./src
COPY scripts ./scripts
COPY --from=build /app/src/server/public/dist ./src/server/public/dist

# 数据目录（日志 / 文章存档），建议挂载到宿主机持久化
VOLUME ["/app/logs", "/app/articles"]

EXPOSE 3000

# 默认 websocket 模式（飞书长连接 + Web + 定时任务）；
# 其他模式：docker run <image> node src/main.js --mode=server|scheduler|web|once
CMD ["node", "src/main.js", "--mode=websocket"]
