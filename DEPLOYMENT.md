# 生产部署实战手册（Docker + 远程 ECS + Nginx 反代 + 数据持久化）

> 本文档由 **蒲公英中医 ClinicalCopilot v2.9** 的真实上线经验沉淀而成，所有命令、端口、卷名、配置项均在线上服务器验证过（阿里云 ECS `101.132.42.13`）。
> 目标是**可复用到其他项目**：把"变量"替换掉，流程与坑位清单可直接照搬。

---

## 0. 一句话架构

```
浏览器 ──HTTPS──> Nginx（宿主 443 / 8443，真实证书）
                     │  proxy_pass http://127.0.0.1:8001
                     ▼
              Docker 网络 pgy_internal
                ├─ app 容器（uvicorn :8000，仅绑定宿主 127.0.0.1:8001）
                └─ db  容器（postgres:17-alpine :5432，不绑定宿主端口）
                     └─ 命名卷 pgy-v29_pgy_pgdata → 唯一真实数据源
```

关键设计（三条铁律，直接决定安全性与可运维性）：

1. **数据库不暴露公网**：`db` 服务不写 `ports`，只在容器网络内可达。
2. **应用只绑回环**：`127.0.0.1:${APP_PORT}:8000`，外网只能经 Nginx 进入，TLS/限流/审计集中在 Nginx 一层。
3. **所有状态落到命名卷**：容器可随时销毁重建，数据不丢。

---

## 1. 部署架构分层的职责

| 层 | 组件 | 职责 | 变更频率 |
|---|---|---|---|
| 代码/镜像 | `Dockerfile` + `docker compose build` | 可复现的运行环境 | 每次发版 |
| 进程编排 | `docker-compose.yml` | 服务拓扑、健康依赖、卷与端口 | 低 |
| 配置 | 服务器 `/opt/<项目>/.env` | 密钥、域名、开关（**不进 git**） | 视需要 |
| 数据 | Docker 命名卷 | 数据库 / 缓存 / 研究数据 | 只增量 |
| 入口 | 宿主 Nginx | TLS、反代、SSE/WS 透传 | 低 |
| 发布 | `deploy-*.ps1` | 拉代码 → 重建 → 健康检查 | 每次发版 |

---

## 2. Dockerfile 设计要点

参考 [Dockerfile](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/Dockerfile)，值得复制的做法：

```dockerfile
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple/   # 国内构建提速，必须写死

WORKDIR /app

# 1) 非 root 运行：先建用户，最后再 USER 切换
RUN groupadd --system pgy && useradd --system --gid pgy --home-dir /app pgy

# 2) 依赖单独一层：requirements 不变则复用缓存，避免每次改代码都重装依赖
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app
RUN mkdir -p /app/vector-cache && chmod +x /app/deploy/entrypoint.sh && chown -R pgy:pgy /app

USER pgy
EXPOSE 8000

# 3) 容器自带健康检查，compose / 外部探针直接读状态
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health/ready', timeout=3).read()" || exit 1

ENTRYPOINT ["/app/deploy/entrypoint.sh"]
```

配套 [.dockerignore](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/.dockerignore)：**必须排除 `.env`**，否则密钥会被烤进镜像层：

```
.git
.env
.env.*
!.env.example
**/__pycache__
**/*.pyc
*.zip
```

---

## 3. 启动编排：entrypoint 决定"能不能起得来"

[entrypoint.sh](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy/entrypoint.sh) 定义了标准四步启动序，强烈建议所有"Web + 数据库 + 外部依赖"的项目照抄这个骨架：

```
① 等待数据库就绪（最多 60 次 × 1s，失败即 exit，不静默启动）
        ↓
② alembic upgrade head（迁移在入口执行，不在 build 时执行）
        ↓
③ 检查/构建持久化向量索引（失败只 warn，保留降级路径，不阻断启动）
        ↓
④ exec uvicorn（exec 让 PID 1 变成应用，能正确接收 SIGTERM 优雅退出）
```

要点解释：

- **① 用 Python 直连探活**，比 `wait-for-it.sh` 之类的外部脚本更少一个依赖：

```sh
python - <<'PY'
import os,time
from sqlalchemy import create_engine,text
url=os.environ['DATABASE_URL']
last=None
for i in range(60):
    try:
        eng=create_engine(url,pool_pre_ping=True)
        with eng.connect() as c: c.execute(text('SELECT 1'))
        print('database ready'); break
    except Exception as e:
        last=e; print(f'waiting for database ({i+1}/60): {e}'); time.sleep(1)
else:
    raise SystemExit(f'database unavailable: {last}')
PY
```

- **② 迁移放入口**：镜像自包含、可回滚；绝不在 build 阶段跑迁移（构建可能并行、可能无库可连）。
- **③ 非核心能力要允许降级**：向量索引构建失败只打 warning，确定性检索兜底继续服务——**"能降级"比"全都能跑"更重要**。
- **④ `exec` 不能省**：否则 PID 1 是 shell，`docker stop` 会退化成 10 秒后 SIGKILL，事务可能被打断。
- **⑤ 加 `--proxy-headers --forwarded-allow-ips='*'`**：应用在 Nginx 后面才能拿到真实客户端 IP 与协议。

---

## 4. docker-compose.yml 设计要点

参考 [docker-compose.yml](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/docker-compose.yml)：

```yaml
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: pgy
      POSTGRES_USER: pgy
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}   # 变量缺失直接拒绝启动
    volumes:
      - pgy_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pgy -d pgy"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [pgy_internal]
    # 注意：没有 ports —— 数据库不暴露宿主端口

  app:
    build: .
    restart: unless-stopped
    env_file: .env                                     # 配置外置，不进镜像
    environment:
      DATABASE_URL: postgresql+psycopg://pgy:${POSTGRES_PASSWORD}@db:5432/pgy   # 容器内用服务名 db，不是 localhost
    depends_on:
      db:
        condition: service_healthy                     # 等健康检查通过，而非仅"启动"
    ports:
      - "127.0.0.1:${APP_PORT:-8000}:8000"             # 只绑回环
    volumes:
      - pgy_vector_cache:/app/vector-cache             # 持久化可重建缓存
      - pgy_beta_data:/app/data/beta
    networks: [pgy_internal]

volumes: { pgy_pgdata: , pgy_vector_cache: , pgy_beta_data: }
networks: { pgy_internal: }
```

必须守住的 6 条：

| # | 规则 | 原因 |
|---|---|---|
| 1 | `db` 不写 `ports` | 数据库永不暴露公网 |
| 2 | `app` 端口绑 `127.0.0.1` | 外网只能走 Nginx |
| 3 | `${VAR:?err}` 强校验 | 密码/端口漏配时"启动失败"优于"带默认值跑起来" |
| 4 | `depends_on: service_healthy` | 避免 app 先起、DB 未就绪导致入口脚本重试 |
| 5 | 容器内连库用服务名 `db` | 写成 `localhost` 会在容器里连自己 |
| 6 | **目录名即 Compose 项目名** | 卷名前缀 = 项目名；改目录名 = 换了一套空卷（见 §6） |

---

## 5. 数据持久化：哪些数据必须活下来

线上实际卷（`docker volume ls` 实测）：

```
pgy-v29_pgy_pgdata          # PostgreSQL 数据目录 —— 唯一不可再生数据
pgy-v29_pgy_vector_cache    # 向量索引缓存 —— 可从知识库重建
pgy-v29_pgy_beta_data       # 研究/盲测导出数据 —— 不入 git，需自行备份
```

分类原则：

| 类型 | 例子 | 丢了会怎样 | 策略 |
|---|---|---|---|
| **不可再生** | 数据库（病例、医生账号、审计日志） | 灾难 | 定时 `pg_dump` + 异地保存 |
| **可重建** | 向量索引缓存 | 首次启动变慢 | 挂卷复用即可，不必备份 |
| **研究/一次性产物** | 盲测导出、去标识化数据 | 需重新跑 | 单独卷，按需导出 |

### 5.1 备份（推荐做法，本项目尚未自动化）

当前服务器 `crontab -l` 为空，**没有定时备份**——这是现存最大风险点。建议如下（宿主 crontab，每日 03:00）：

```bash
# /etc/cron.daily/pgy-v29-backup
#!/bin/sh
set -eu
STAMP=$(date +%F)
mkdir -p /root/backups
docker exec pgy-v29-db-1 pg_dump -U pgy -d pgy | gzip > /root/backups/pgy-v29-$STAMP.sql.gz
find /root/backups -name 'pgy-v29-*.sql.gz' -mtime +14 -delete   # 本机保留 14 天
```

再配一条**异地**同步（对象存储 `ossutil`/`rclone` 或另一台机器 `rsync`），遵循 3-2-1 原则：3 份副本、2 种介质、1 份离线。

### 5.2 恢复演练（务必真的演练一次）

```bash
# 1) 停应用，保留 DB（避免写入半途污染）
cd /opt/pgy-v29 && docker compose stop app
# 2) 灌入备份
gunzip -c /root/backups/pgy-v29-2026-09-20.sql.gz | docker exec -i pgy-v29-db-1 psql -U pgy -d pgy
# 3) 起应用并验证
docker compose start app
curl -fsS http://127.0.0.1:8001/api/health/ready
```

### 5.3 卷相关红线

- **禁止** `docker compose down -v`：`-v` 会删除命名卷 = 删库。
- **禁止**在 `docker-compose.yml` 里改卷名（如 `pgy_pgdata` → `pgy_pgdata_v2`）：compose 会创建一个空卷，表现为"数据全没了"。
- 备份文件内含患者数据，**不得**上传到公开位置或提交到 git。
- 定期清理构建缓存（线上实测 Build Cache 已 29GB）：`docker builder prune -f`、`docker image prune -f`。

---

## 6. 多版本并行隔离（踩过坑才总结出来）

线上同时存在 v2.8 与 v2.9 两套服务，做法是**四维全隔离**：

| 维度 | v2.8 | v2.9 |
|---|---|---|
| 部署目录 | `/opt/pgy-v28` | `/opt/pgy-v29` |
| Compose 项目名 | `pgy-v28` | `pgy-v29` |
| 数据卷前缀 | `pgy-v28_*` | `pgy-v29_*` |
| 宿主端口 | `8000` | `8001` |

结论：**不要试图在同一套 compose 里"改造"上线新版本**。新目录 + 新项目名 + 新端口，新版本可独立启动、验证、回滚；确认无误后再 `docker compose down` 停掉旧版（保留其数据卷作为冷备份）。

> 注意：Compose 项目名默认取**部署目录的 basename**。`/opt/pgy-v29` → 项目 `pgy-v29` → 容器名 `pgy-v29-app-1` / `pgy-v29-db-1`，卷名 `pgy-v29_pgy_pgdata`。改名即换库，务必先在原目录 `down` 再改名，或将旧卷显式声明为 `external`。

---

## 7. 私有仓库 + 远程服务器发布链路

### 7.1 首次部署（服务器初始化）

**Step 1 · 上传 GitHub Deploy Key（只读权限）**

```
scp -i .deploy\pgy_deploy .deploy\deploy_v29 root@<SERVER>:/root/.ssh/deploy_v29
ssh -i .deploy\pgy_deploy root@<SERVER> "chmod 600 /root/.ssh/deploy_v29"
```

本地只保留公钥（`.deploy\deploy_v29.pub`）作登记；私钥仅在服务器上，仓库里登记为只读 deploy key。

**Step 2 · 克隆私有仓库到隔离目录**

```
ssh -i .deploy\pgy_deploy root@<SERVER> \
  "GIT_SSH_COMMAND='ssh -i /root/.ssh/deploy_v29 -o StrictHostKeyChecking=accept-new' \
   git clone git@github.com:<ORG>/<REPO>.git /opt/pgy-v29"
```

**Step 3 · 落地服务器 `.env`（不进 git）**

以仓库 `.env.example` 为模板，服务器上按需覆盖差异键（本项目线上实际值）：

```
APP_ENV=production
AUTO_CREATE_SCHEMA=false                    # 生产强制走 Alembic
COOKIE_SECURE=true
ALLOWED_HOSTS=localhost,127.0.0.1,<SERVER_IP>,www.example.com,example.com
BOOTSTRAP_ADMIN_LOGIN=admin
WEB_CONCURRENCY=2
APP_PORT=8001                               # 与旧版本错开
KNOWLEDGE_RELEASE=<当前知识版本>
DATABASE_URL=postgresql+psycopg://pgy:***@db:5432/pgy    # 容器内地址，勿改 localhost
```

**Step 4 · Nginx 反代落盘 + reload**

```
scp -i .deploy\pgy_deploy deploy/nginx-*.conf root@<SERVER>:/etc/nginx/conf.d/pgy-v29.conf
ssh -i .deploy\pgy_deploy root@<SERVER> "nginx -t && systemctl reload nginx"
```

**Step 5 · 构建启动**

```
ssh -i .deploy\pgy_deploy root@<SERVER> "cd /opt/pgy-v29 && docker compose up -d --build"
```

### 7.2 日常热更新（一键脚本）

[deploy-v29.ps1](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy-v29.ps1) 的四段式流程，是整套经验里**最值得复用**的部分：

```
[1/4] 本地 git fetch origin main，比对 localHead 与 originHead
      ├─ 不一致 → 警告并交互确认（防止"以为上线了其实没 push"）
      └─ 工作区脏 → 警告（服务器只会部署 origin/main 已提交版本）
[2/4] 服务器 git pull --ff-only origin main   ← 增量传输，仅差异文件
[3/4] 服务器 docker compose up -d --build     ← 层缓存命中时约 30 秒
[4/4] 健康检查：docker compose ps + /api/health/ready + /api/health
```

**为什么用 `git pull` 而不是 `scp`/`rsync` 上传代码：**

- 增量传输，大仓库不必全量重传；
- 服务器上的代码版本 = 一个 commit hash，**可审计、可精确回滚**（`git checkout <commit> && docker compose up -d --build`）；
- 部署前能比对本地与远端是否一致，避免"本地改了忘 push"的经典事故；
- `--ff-only` 保证只做快进合并，不会在服务器上产生 merge commit。

**为什么脚本必须是"长命令"：** 远程 `docker build` 首构 2–5 分钟，缓存命中约 30 秒。执行时务必异步启动 + 轮询输出，不要同步等待。

---

## 8. Nginx 反代：HTTP、SSE、WebSocket 一个都不能少

参考 [nginx-pgytcm-https.conf](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy/nginx-pgytcm-https.conf)（仓库模板）与 [nginx.conf.example](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy/nginx.conf.example)。

### 8.1 端口策略（线上实测）

| 端口 | 归属 | 说明 |
|---|---|---|
| 443 | Nginx | 标准 HTTPS，域名访问（需安全组放行） |
| 8443 | Nginx | 备用 HTTPS，含 IP 直连访问，安全组已放行 |
| 8001 | app 容器 | **仅宿主 127.0.0.1 可见** |
| 8000 | 容器内 uvicorn | 不出容器 |
| 5432 | db 容器 | **仅容器网络内**，宿主不可见 |

### 8.2 关键 location 配置

```nginx
server {
    listen 443 ssl;
    server_name www.example.com example.com;

    ssl_certificate     /etc/nginx/ssl/example.com.pem;
    ssl_certificate_key /etc/nginx/ssl/example.com.key;

    client_max_body_size 32m;          # 按业务放大（音频/文档上传）

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_buffering off;           # ★ 关键：不缓冲，SSE 才能实时推送
        proxy_cache off;               # ★ 关键：不缓存流式响应
        proxy_read_timeout 600s;       # ★ 关键：长任务（LLM 推理）别被 Nginx 掐断
    }

    location /ws/ {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;      # ★ WebSocket 升级
        proxy_set_header Connection "upgrade";          # ★ 二者缺一不可
        proxy_set_header Host       $host;
        proxy_read_timeout 600s;
    }
}
```

**三个最容易踩的 Nginx 坑：**

1. `proxy_buffering on`（默认值）会让 SSE 变成"攒完一次性吐"——前端进度条卡死不动。
2. 忘写 `Upgrade`/`Connection` 两个 header，WebSocket 握手 400。
3. `proxy_read_timeout` 用默认 60s，长推理请求被 504。

### 8.3 与应用侧配置对齐（必须成对出现）

| Nginx 侧 | 应用侧 | 不对齐的后果 |
|---|---|---|
| `Host` 透传 | `ALLOWED_HOSTS` 含该域名 | 域名访问报 `Invalid host header` |
| `X-Forwarded-Proto $scheme` | uvicorn `--proxy-headers --forwarded-allow-ips='*'` | Cookie `Secure`、重定向协议判断错误 |
| `client_max_body_size` | 应用侧上传上限 | 大于 Nginx 限制时 413 |

### 8.4 HTTPS / 证书 / 80 跳转

- 80 端口只做 ACME 校验 + 301 跳 HTTPS（[nginx-pgytcm-http.conf](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy/nginx-pgytcm-http.conf)）。
- 证书文件放宿主 `/etc/nginx/ssl/`，**私钥绝不出服务器**，仓库 `.gitignore` 已排除 `*.key` / `*.pem`。
- 若不想自己管证书，可选 Caddy 自动 HTTPS：[docker-compose.https.yml](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy/docker-compose.https.yml) + [Caddyfile](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy/Caddyfile)，注意 SSE 需 `flush_interval -1`。

---

## 9. 配置管理：`.env` 的权威在哪

| 事实 | 说明 |
|---|---|
| `.env` 被 `.gitignore` / `.dockerignore` 双重排除 | 改本地 `.env` **不会**自动上线 |
| **服务器 `/opt/<项目>/.env` 才是运行时权威** | 改完需 `docker compose up -d --force-recreate app` 才生效 |
| 容器内连库地址是 `db:5432` | 服务器上写 `localhost` 会连到容器自身 |
| 部分配置存 DB 优先 | 例如大模型配置：只改 `.env` 里 API Key 不够，还需同步 `llm_configs` 表 |
| 生产硬校验 | `APP_SECRET` ≥32 位随机、`AUTO_CREATE_SCHEMA=false`、管理员密码非默认值，否则启动即抛错 |

生成 `.env` 的一次性脚本可参考 [create_env.py](file:///d:/self/PGYV2.9/ClinicalCopilot_v2.9/deploy/create_env.py)（自动生成随机 `APP_SECRET`、校验 DB 密码不含 URL 保留字符、写入后 `chmod 600`）。

---

## 10. 运维手册（抄这一节就够了）

```bash
# 容器状态（期望 app 为 Up (healthy)）
ssh -i .deploy/pgy_deploy root@<SERVER> "cd /opt/pgy-v29 && docker compose ps"

# 应用日志
ssh -i .deploy/pgy_deploy root@<SERVER> "cd /opt/pgy-v29 && docker compose logs --tail=100 app"

# 健康检查（三档：存活 / 概要 / 就绪）
curl -fsS http://127.0.0.1:8001/api/health/live
curl -fsS http://127.0.0.1:8001/api/health
curl -fsS http://127.0.0.1:8001/api/health/ready

# 改 .env 后重建单容器
ssh -i .deploy/pgy_deploy root@<SERVER> "cd /opt/pgy-v29 && docker compose up -d --force-recreate app"

# 回滚
ssh -i .deploy/pgy_deploy root@<SERVER> "cd /opt/pgy-v29 && git log --oneline -5"
ssh -i .deploy/pgy_deploy root@<SERVER> "cd /opt/pgy-v29 && git checkout <COMMIT> && docker compose up -d --build"

# 磁盘与缓存巡检
ssh -i .deploy/pgy_deploy root@<SERVER> "df -h / && docker system df"
```

账号体系：首次启动仅 `bootstrap()` 建平台管理员（`BOOTSTRAP_ADMIN_*`）；医生账号需管理员登录后在「管理 → 用户」先建诊所、再建 `DOCTOR` 角色账号。

---

## 11. 坑位清单（Checklist，逐条对照）

**构建 / 镜像**

- [ ] `.dockerignore` 必须排除 `.env`、`.git`、`__pycache__`、`*.zip`。
- [ ] `requirements.txt` 单独一层 COPY，改业务代码不触发重装依赖。
- [ ] pip 源按服务器所在地写死（国内用清华源；实测阿里云 ECS 上阿里云源不可用，清华源可用）。
- [ ] 容器以非 root 用户运行。
- [ ] 镜像内 `HEALTHCHECK` 指向一个**真实存在**的就绪端点。

**编排 / 数据**

- [ ] `db` 无 `ports`；`app` 只绑 `127.0.0.1`。
- [ ] 关键变量用 `${VAR:?error}` 强制校验。
- [ ] 所有状态落命名卷；**永不**使用 `down -v`。
- [ ] 定时 `pg_dump` + 异地备份，并**演练过一次恢复**。
- [ ] 定期 `docker builder prune`（构建缓存会无声涨到几十 GB）。

**发布链路**

- [ ] 服务器 SSH 私钥与 GitHub Deploy Key 分离，Deploy Key 只读。
- [ ] 部署脚本先校验 localHead == originHead，再 `git pull --ff-only`。
- [ ] 部署是长命令：异步执行 + 轮询状态，不要同步阻塞等待。
- [ ] 发版后必须跑健康检查，不能只看"容器起来了"。

**Nginx / 网络**

- [ ] SSE：`proxy_buffering off` + `proxy_cache off` + 长 `proxy_read_timeout`。
- [ ] WebSocket：`Upgrade` + `Connection "upgrade"` 两个 header。
- [ ] `ALLOWED_HOSTS` 覆盖全部对外域名与 IP。
- [ ] uvicorn 带 `--proxy-headers --forwarded-allow-ips`。
- [ ] 证书/私钥不入仓库；安全组只放行必要端口。
- [ ] **仓库里的 nginx conf 与服务器实际 conf 定期 diff**（本项目已出现漂移：仓库 `proxy_read_timeout 180s`，线上为 `600s`，建议以线上为准回写仓库）。

**密钥卫生**

- [ ] SSH 私钥、API Key、DB 密码一律只存在于服务器 `.env` 与 `.deploy/`，**不打印、不入库、不进镜像**。
- [ ] Windows 下 OpenSSH 报 `UNPROTECTED PRIVATE KEY FILE` 时执行：
      `icacls <key> /inheritance:r /grant:r '<用户名>:R'`

---

## 12. 换到新项目：只需替换这些变量

| 类别 | 本项目取值 | 新项目替换为 |
|---|---|---|
| 服务器 | `<SERVER_IP>` / 用户 `root` | 你的 ECS 地址与账号 |
| 登录私钥 | `.deploy/pgy_deploy` | 你的 SSH 私钥 |
| 仓库 | `git@github.com:<ORG>/<REPO>.git` | 你的私有仓库 |
| Deploy Key | 服务器 `/root/.ssh/deploy_v29` | 你的服务器端部署私钥路径 |
| 部署目录 | `/opt/pgy-v29` | `/opt/<你的项目>-<版本>`（**目录名即 Compose 项目名**） |
| 宿主端口 | `8443` / `443` → `8001` | 你的对外端口 → 应用端口 |
| 命名卷 | `pgy-v29_pgy_pgdata` 等 | `<项目>_<卷名>` |
| 域名 / 证书 | `www.pgytcm.com` | 你的域名与证书路径 |
| 环境变量 | `ALLOWED_HOSTS` / `APP_PORT` / `KNOWLEDGE_RELEASE` | 你的对应项 |

其余（Dockerfile 结构、entrypoint 四步序、compose 六条规则、Nginx 三坑、发布四段式、运维命令、坑位清单）**可原样复用**。
