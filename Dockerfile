FROM node:22-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com

WORKDIR /app

# 1) 依赖层单独 COPY+安装：业务代码变更不触发重装依赖
#    tsx 在运行时编译 TS，属 devDependencies，故必须 --include=dev
COPY pgy-clinical-mvp/package.json pgy-clinical-mvp/package-lock.json /app/pgy-clinical-mvp/
RUN cd /app/pgy-clinical-mvp && npm ci --include=dev

# 2) 代码与启动脚本
COPY pgy-clinical-mvp /app/pgy-clinical-mvp
COPY deploy /app/deploy

# 3) 非 root 运行；data 为账号/会话持久化目录（本地开发不挂卷也能跑）
RUN useradd --system --create-home --home-dir /app --shell /usr/sbin/nologin pgy \
 && mkdir -p /app/pgy-clinical-mvp/data /app/assets \
 && chmod +x /app/deploy/entrypoint.sh \
 && chown -R pgy:pgy /app
USER pgy

WORKDIR /app/pgy-clinical-mvp
EXPOSE 8787

# 健康检查走容器内真实就绪端点（免登录探针）
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "/app/deploy/healthcheck.mjs"]

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
