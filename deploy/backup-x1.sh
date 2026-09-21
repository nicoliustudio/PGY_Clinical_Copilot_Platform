#!/bin/sh
# 每日备份 pgy-x1 唯一不可再生数据：账号与会话（命名卷 pgy-x1_data）
# 安装：/etc/cron.d/pgy-x1-backup 中每日 03:00 调用
# 恢复：见 DEPLOYMENT.md「数据与备份」
set -eu

STAMP=$(date +%F)
DIR=/root/backups
mkdir -p "$DIR"

# 复用已存在的应用基础镜像，避免额外拉取；只读挂载数据卷
docker run --rm \
  -v pgy-x1_data:/data:ro \
  -v "$DIR":/backup \
  node:22-slim \
  tar czf "/backup/pgy-x1-data-$STAMP.tgz" -C /data .

# 本机保留 14 天；异地副本请另配 ossutil/rclone（3-2-1 原则）
find "$DIR" -name 'pgy-x1-data-*.tgz' -mtime +14 -delete

echo "[backup] 完成：$DIR/pgy-x1-data-$STAMP.tgz ($(du -h "$DIR/pgy-x1-data-$STAMP.tgz" | cut -f1))"
