#!/bin/sh
# 容器启动序：校验挂载 → 确认知识索引 → 启动服务。
# 密钥与业务参数由 config.ts / auth.ts 自行强校验（缺失即抛错退出），此处不重复。
set -eu

cd /app/pgy-clinical-mvp

echo "[pgy] 环境：NODE_ENV=${NODE_ENV:-} APP_PORT=${APP_PORT:-8787} KB_RELEASE_DIR=${KB_RELEASE_DIR:-<未设置>}"

# ① 知识库 release 必须存在：bind mount 配错/漏传 assets 是最常见的部署事故，
#    在此直接失败并给出指引，比启动后在检索阶段报错更容易定位。
if [ -z "${KB_RELEASE_DIR:-}" ]; then
  echo "[pgy] 致命：未设置 KB_RELEASE_DIR" >&2
  exit 1
fi
if [ ! -d "$KB_RELEASE_DIR" ]; then
  echo "[pgy] 致命：知识库目录不存在：$KB_RELEASE_DIR" >&2
  echo "[pgy] 请确认宿主 assets 已挂载到容器 /app/assets（只读）" >&2
  exit 1
fi

# ② 预构建索引：有则秒起，无则首次请求时重建（消耗 embedding 额度），仅提示不阻断
INDEX_FILE=".kb-cache/index.$(basename "$KB_RELEASE_DIR").json"
if [ -f "$INDEX_FILE" ]; then
  echo "[pgy] 复用预构建知识索引：$INDEX_FILE"
else
  echo "[pgy] 警告：未找到预构建索引（$INDEX_FILE），首次检索将在线重建并消耗 embedding 额度" >&2
fi

# ③ exec 让应用成为 PID 1，docker stop 时能收到 SIGTERM 优雅退出
exec node --import tsx src/server/index.ts
