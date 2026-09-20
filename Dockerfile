# StageBlock —— 话剧走位连续性检查
# 依赖安装（含 better-sqlite3 原生模块编译）在 builder 阶段完成

FROM node:20-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
RUN mkdir -p data
EXPOSE 3000
# 数据库初始化与示例数据写入均在首次启动时自动完成
CMD ["node", "server/index.js"]
