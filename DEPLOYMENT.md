# 蒲公英中医 Clinical Copilot v1（X1）生产部署手册

> 本文档记录 **X1（本仓库）** 在阿里云 ECS `101.132.42.13` 上的真实上线过程，命令与配置均在线上验证过。
> 与旧平台 v2.8 / v2.9 的经验一脉相承，但本项目是 **Node 单容器、无数据库** 形态，故拓扑与运维方式与之不同。

---

## 0. 一句话架构

```
浏览器 ──HTTPS:443 / 备用 8443──> 宿主 Nginx（真实证书 www.pgytcm.com）
                                    │  proxy_pass http://127.0.0.1:8002
                                    ▼
                          Docker 容器 pgy-x1-app-1（Node 22 + tsx，:8787）
                                    ├─ 只读挂载 /opt/pgy-x1/assets        → /app/assets        （知识库，185MB，不入 git）
                                    ├─ 命名卷   pgy-x1_data               → /app/pgy-clinical-mvp/data      （账号+会话，唯一不可再生）
                                    └─ 宿主目录 ./pgy-clinical-mvp/.kb-cache → /app/pgy-clinical-mvp/.kb-cache（向量索引，可重建）
```

三条铁律（与旧平台一致）：

1. **应用只绑回环**：`127.0.0.1:8002`，外网一律经 Nginx，TLS/限流集中在 Nginx 一层。
2. **唯一不可再生数据进命名卷**：账号与会话（`pgy-x1_data`），不会被 `git clean` 或误删宿主目录带走。
3. **密钥只在服务器 `.env`**：不进 git、不进镜像、不进日志。

---

## 1. 与旧平台的隔离（四维全隔离）

| 维度 | v2.8（已停） | v2.9（旧平台） | **X1（本项目）** |
|---|---|---|---|
| 部署目录 | `/opt/pgy-v28` | `/opt/pgy-v29` | **`/opt/pgy-x1`** |
| Compose 项目名 | `pgy-v28` | `pgy-v29` | **`pgy-x1`** |
| 容器名 | `pgy-v28-app-1` | `pgy-v29-app-1` / `pgy-v29-db-1` | **`pgy-x1-app-1`** |
| 命名卷 | `pgy-v28_*` | `pgy-v29_*` | **`pgy-x1_data`** |
| 宿主端口 | 8000 | 8001 | **8002** |
| 域名入口 | — | `101.132.42.13:8443`（仅 IP） | **`www.pgytcm.com`（443 / 8443）** |

> Compose 项目名 = 部署目录 basename。改名即换一套容器与卷，务必留有原目录再改名。

**两平台共存状态**：v2.9 完全未动（仍监听 `127.0.0.1:8001`），X1 独立监听 `127.0.0.1:8002`，互不影响。

---

## 2. Dockerfile 设计要点

参考 [Dockerfile](file:///d:/self/pgyx1.0/PGYxv1.0/Dockerfile)：

| 做法 | 原因 |
|---|---|
| 基础镜像 `node:22-slim` | 与 `package.json` 的 `engines: node>=22` 对齐 |
| **依赖层单独 COPY + `npm ci`** | 改业务代码不触发重装依赖 |
| `npm ci --include=dev` | 运行时用 `tsx` 编译 TS，`tsx` 属 devDependencies；`NODE_ENV=production` 会默认跳过 dev 依赖 |
| 非 root 用户 `pgy` | 容器内不以 root 跑业务 |
| `HEALTHCHECK` → `/api/health` | 免登录探针，且校验 `knowledge.ok`；探针脚本见 [healthcheck.mjs](file:///d:/self/pgyx1.0/PGYxv1.0/deploy/healthcheck.mjs) |
| `COPY deploy` | entrypoint / 健康检查脚本单独一层，改脚本不必重装依赖 |
| `NPM_CONFIG_REGISTRY=https://registry.npmmirror.com` | 国内构建提速 |

[.dockerignore](file:///d:/self/pgyx1.0/PGYxv1.0/.dockerignore) 必须排除：`.env`（密钥）、`assets/`（185MB 知识资产）、`.kb-cache/`（220MB 索引）、`data/`（账号）。二者合计 400MB，进镜像会拖慢每一次构建。

---

## 3. entrypoint 启动序

参考 [entrypoint.sh](file:///d:/self/pgyx1.0/PGYxv1.0/deploy/entrypoint.sh)：

```
① 校验 KB_RELEASE_DIR 存在（bind mount 配错/漏传 assets 是最常见事故，此处直接失败并给指引）
        ↓
② 检测预构建索引是否存在（有则复用；无则提示首次检索将在线重建并消耗 embedding 额度，不阻断）
        ↓
③ exec node --import tsx src/server/index.ts（exec 让应用成为 PID 1，docker stop 才能优雅退出）
```

密钥缺失**不在这里校验**：`src/config.ts` 与 `src/server/auth.ts` 各自抛出明确错误（`缺少环境变量 X` / `缺少 APP_SECRET`），启动即失败，无需重复。

`exec` 不能省：否则 PID 1 是 shell，`docker stop` 会退化成 10 秒后 SIGKILL。

---

## 4. docker-compose 要点

参考 [docker-compose.yml](file:///d:/self/pgyx1.0/PGYxv1.0/docker-compose.yml)：

| # | 规则 | 原因 |
|---|---|---|
| 1 | `ports: "127.0.0.1:8002:8787"` | 只绑回环；8000/8001 已被旧版占用 |
| 2 | `env_file: pgy-clinical-mvp/.env` | **与应用 dotenv 读的是同一个文件**：`npm run serve` 与容器行为一致，不会出现两套配置漂移 |
| 3 | 无 `db` 服务 | 本项目无数据库（会话与账号落文件） |
| 4 | `./assets:/app/assets:ro` | 知识资产只读；容器工作目录是 `/app/pgy-clinical-mvp`，故 `.env` 里 `KB_RELEASE_DIR=../assets/...` 正好解析到它 |
| 5 | `data:/app/pgy-clinical-mvp/data` | 不可再生数据 → 命名卷 |
| 6 | `./pgy-clinical-mvp/.kb-cache:...` | 可重建数据 → 宿主目录，便于预传索引、随时替换 |

**数据分级**（照抄旧平台结论，落到本项目）：

| 类型 | 本项目对应物 | 丢了会怎样 | 策略 |
|---|---|---|---|
| 不可再生 | 账号与会话（`pgy-x1_data`） | 需重新建档 | 每日 `pg_dump` 等价物：卷打包备份 |
| 可重建 | 向量索引（`.kb-cache`） | 首次启动变慢 + 一次 embedding 开销 | 宿主目录按需替换，无需备份 |
| 无需入库 | 知识资产（`assets/`） | 检索不可用 | 只读挂载，独立同步 |

---

## 5. 数据与备份

### 5.1 现状（已自动化，补上了旧平台缺失的一环）

```bash
# 每日 03:00 由 /etc/cron.d/pgy-x1-backup 触发
cat /etc/cron.d/pgy-x1-backup
# 0 3 * * * root /opt/pgy-x1/deploy/backup-x1.sh >/dev/null 2>&1

sh /opt/pgy-x1/deploy/backup-x1.sh        # 手动试跑
ls -lh /root/backups/                      # pgy-x1-data-YYYY-MM-DD.tgz（本机保留 14 天）
```

备份脚本 [backup-x1.sh](file:///d:/self/pgyx1.0/PGYxv1.0/deploy/backup-x1.sh) 只读挂载数据卷后用 `tar` 打包，产物内含 `users.json` 与 `sessions.json`。

**尚未做**：异地副本（3-2-1 原则）。建议加 `ossutil`/`rclone` 把 `/root/backups` 同步到对象存储。

### 5.2 恢复演练（务必真跑一次）

```bash
ssh -i .deploy/pgy_deploy root@101.132.42.13
cd /opt/pgy-x1 && docker compose stop app
docker run --rm -v pgy-x1_data:/data -v /root/backups:/backup node:22-slim \
  sh -c 'rm -rf /data/* && tar xzf /backup/pgy-x1-data-YYYY-MM-DD.tgz -C /data'
docker compose start app
curl -fsS http://127.0.0.1:8002/api/health
```

### 5.3 红线

- **禁止** `docker compose down -v`：`-v` 会删掉命名卷 = 删掉全部账号。
- **禁止**改 `docker-compose.yml` 里的卷名（`data` → `data_v2`）：Compose 会新建空卷，表现为"账号全没了"。
- 备份产物含账号摘要与登录态，**不得**上传公开位置或提交 git。
- `pgy-clinical-mvp/.kb-cache/` 是宿主目录，`git clean -xdf` 会删它（可重建，但下次检索会重新构建）。

---

## 6. 首次部署（本次实际执行的 6 步）

### Step 1 · 服务器 SSH 部署密钥（只读）

```bash
# 服务器上生成（本次已生成 /root/.ssh/deploy_x1）
ssh-keygen -t ed25519 -N '' -C 'pgy-x1 deploy key' -f /root/.ssh/deploy_x1
cat /root/.ssh/deploy_x1.pub
```

公钥登记到仓库 `Settings → Deploy keys`（本次通过 GitHub API 添加，id 163923433，`read_only: true`），之后：

```bash
GIT_SSH_COMMAND='ssh -i /root/.ssh/deploy_x1 -o StrictHostKeyChecking=accept-new' \
  git clone git@github.com:nicoliustudio/PGY_Clinical_Copilot_Platform.git /opt/pgy-x1
```

> 注意：本仓库为**公开仓库**，clone 本身不需要凭据，但服务器访问 GitHub 的 HTTPS(443) 不稳定（实测超时），SSH(22) 正常 —— 因此统一走 SSH。

### Step 2 · 知识资产上服务器（git 里没有）

`assets/` 被 `.gitignore` 排除（版权原文 + 评测 gold + 真实病例），必须单独同步。运行时只读两处：`releases/<tag>` 与 `runtime-catalog`（`sources/`、`derived/`、`extensions/` 运行时不读）：

```powershell
tar -czf assets.tgz -C <repo> assets/knowledge/releases assets/knowledge/runtime-catalog
scp -i .deploy\pgy_deploy assets.tgz root@101.132.42.13:/tmp/
ssh ... "tar -xzf /tmp/assets.tgz -C /opt/pgy-x1"      # → /opt/pgy-x1/assets（实测 124MB）
```

### Step 3 · 预构建向量索引（省一次 embedding 开销）

```powershell
tar -czf kbcache.tgz -C <repo>\pgy-clinical-mvp .kb-cache\index.<releaseTag>.json
scp ... → 解包到 /opt/pgy-x1/pgy-clinical-mvp/.kb-cache/
```

索引文件名必须与 `KB_RELEASE_DIR` 的 basename 一致（`index.2026.09.18-agent-ready-r1.json`），entrypoint 按此规则探测。启动日志出现 `复用预构建知识索引` 即成功。

### Step 4 · 服务器 `.env`

**位置：`/opt/pgy-x1/pgy-clinical-mvp/.env`（权限 600）**，是运行时唯一权威配置。以 `.env.example` 为模板，关键差异：

```
COOKIE_SECURE=true                                   # 经 HTTPS 对外，必须
APP_SECRET=<openssl rand -hex 32>                    # 会话签名密钥，泄露=会话可伪造
BOOTSTRAP_ADMIN_PASSWORD / BOOTSTRAP_DOCTOR_PASSWORD # 首次启动建档用
KB_RELEASE_DIR=../assets/knowledge/releases/<tag>    # 相对容器工作目录，勿改绝对路径
APP_PORT=8787                                        # 须与 compose 端口映射容器侧一致
```

### Step 5 · 构建启动

```bash
ssh ... "cd /opt/pgy-x1 && docker compose up -d --build"
ssh ... "cd /opt/pgy-x1 && docker compose ps"     # 期望 Up (healthy)
```

### Step 6 · Nginx

```bash
scp deploy/nginx-pgy-x1.conf          root@<SERVER>:/etc/nginx/conf.d/pgy-x1.conf
scp deploy/nginx-pgy-v29-ip-only.conf root@<SERVER>:/etc/nginx/conf.d/pgy-v29.conf   # 旧平台退到仅 IP
ssh ... "nginx -t && systemctl reload nginx"
```

旧配置已备份为 `/root/pgy-v29.conf.bak.<时间戳>`。

---

## 7. 日常热更新

[deploy-x1.ps1](file:///d:/self/pgyx1.0/PGYxv1.0/deploy-x1.ps1)：

```
[1/5] 本地 git fetch origin main，比对 localHead 与 originHead（防"以为上线了其实没 push"）
[2/5] 可选 -SyncAssets：重新上传知识资产（日常发版跳过）
[3/5] 服务器 git pull --ff-only origin main         ← 增量传输，仅差异文件
[4/5] 服务器 docker compose up -d --build           ← 层缓存命中时很快
[5/5] docker compose ps + /api/health
```

用法：`.\deploy-x1.ps1`（只发代码）／`.\deploy-x1.ps1 -SyncAssets`（连知识资产一起）。

**为什么用 `git pull` 而不是 `scp` 上传代码**（沿用旧平台结论）：增量传输；服务器代码 = 一个 commit hash，可审计、可精确回滚；部署前能发现"本地改了忘 push"。

**本项目的额外注意**：GitHub HTTPS(443) 在本机与服务器都验证过不稳定，**本地已把 `origin` 切到 SSH**（`git@github.com:nicoliustudio/...`）；服务器 pull 依赖 `/root/.ssh/deploy_x1`。若 pull 失败先看是不是网络而非权限。

---

## 8. Nginx

### 8.1 端口分工（线上实测）

| 入口 | 归属 | 说明 |
|---|---|---|
| 443 | **X1** | `www.pgytcm.com` / `pgytcm.com` → 127.0.0.1:8002 |
| 8443 | X1（域名） / v2.9（IP） | 同一端口按 `server_name` 分流：域名给 X1，`101.132.42.13` 给旧平台 |
| 80 | X1 | 域名 301 跳 HTTPS |
| 8002 | X1 容器 | **仅宿主 127.0.0.1 可见** |
| 8001 | v2.9 容器 | 旧平台，仅宿主可见 |
| 8787 | X1 容器内 Node | 不出容器 |

### 8.2 三个必踩的坑（旧平台踩过，本项目同样适用）

1. `proxy_buffering on`（默认）会让 SSE 变成"攒完一次性吐出" → 前端进度条卡死。必须 `proxy_buffering off` + `proxy_cache off`。
2. WebSocket 少写 `Upgrade` / `Connection "upgrade"` 任一 → 握手 400。本项目语音 ASR 走 `/ws/asr`。
3. `proxy_read_timeout` 用默认 60s → 长推理被 504。本项目设 `600s`。

### 8.3 登录接口限流

```nginx
limit_req_zone $binary_remote_addr zone=pgy_x1_login:10m rate=5r/m;   # 定义在 conf.d 里即处于 http 上下文
location = /api/auth/login { limit_req zone=pgy_x1_login burst=10 nodelay; ... }
```

公网域名 + 账号密码，必须挡住暴力破解。限流放在 Nginx 而不是应用代码里。

### 8.4 8443 上的 `server_name` 不能重复

两个 conf 若在**同一端口**声明同一 `server_name`，Nginx 只警告 `conflicting server name ... ignored` 并静默丢弃后者——这类"看不出错"的配置最容易埋雷。故：8443 的 IP 只给 v2.9，域名只给 X1。

### 8.5 443 / 80 对外的现实约束（本次上线实测，重要）

| 现象 | 原因 |
|---|---|
| `http://www.pgytcm.com/` 返回 `403 Forbidden` + `Server: Beaver` + 标题 `Non-compliance ICP Filing` | **阿里云对未备案域名的 80 端口内容拦截**（不是 Nginx 返回的） |
| `https://www.pgytcm.com/`（443）连接超时 | 443 未在**阿里云安全组**放行（宿主 `ufw` 已放行，问题在上游） |
| `https://www.pgytcm.com:8443/` 正常 | 非 80/443 端口不受备案拦截，这也是旧平台一直用 8443 的原因 |

**结论与待办**：要让 `https://www.pgytcm.com`（默认端口）可用，需在阿里云控制台 (1) 安全组放行 443，(2) 完成 `pgytcm.com` 的 ICP 备案。在此之前，域名请用 **`https://www.pgytcm.com:8443`** 访问。

> 排查提示：若本机配了系统代理（如 `127.0.0.1:7890`），`curl`/`Invoke-WebRequest` 访问该 ECS 的 TLS 端口会立刻失败（几十毫秒 reset），且报错与"服务器不通"极像。判断方法：`curl --noproxy '*'`，或看 `HKCU:\...\Internet Settings` 的 `ProxyServer`。服务端自测（容器内 / 宿主 `127.0.0.1`）不受影响。

---

## 9. 认证与账号

| 项 | 实现 |
|---|---|
| 账号存储 | `data/users.json`（随命名卷持久化，权限 600），**只存 scrypt 摘要** |
| 会话 | HttpOnly + SameSite=Lax Cookie（`pgy_session`），HMAC-SHA256 签名，默认 12h |
| 会话撤销 | `data/sessions.json` 登记表：**登出/失效立即生效**，不是"等到过期" |
| 角色 | `admin`（管理 + 调试/评测面）、`doctor`（临床，无评测面） |
| 守卫位置 | `src/server/http.ts`（HTTP 层）+ `src/server/auth.ts`（凭据与会话）；未登录页面 302 至 `/login`、接口 401；`/api/eval/*` 仅 admin；`/ws/asr` 握手校验会话 |
| 账号来源 | 启动时按 `BOOTSTRAP_ADMIN_*` / `BOOTSTRAP_DOCTOR_*` 幂等建档，**已存在的账号不会被覆盖** |

**重设密码（当前唯一方式）**：改 `.env` 里的 `BOOTSTRAP_*_PASSWORD` → 停容器 → 删除数据卷里的 `users.json` → 启动，账号按新密码重建（旧会话因用户 id 变化自动失效）。

```bash
cd /opt/pgy-x1 && docker compose stop app
docker run --rm -v pgy-x1_data:/data node:22-slim rm -f /data/users.json
docker compose start app && docker compose logs --tail=5 app   # 应出现「已建立账号：admin、doctor」
```

> 待办：用户管理页 / 自助改密（当前没有界面，只能走上面的重建流程）。

---

## 10. 运维手册

```bash
# 容器状态（期望 Up (healthy)）
ssh -i .deploy/pgy_deploy root@101.132.42.13 "cd /opt/pgy-x1 && docker compose ps"

# 应用日志
ssh ... "cd /opt/pgy-x1 && docker compose logs --tail=100 app"

# 健康检查（免登录）
curl -fsS http://127.0.0.1:8002/api/health          # 含 knowledge / capabilities / skills / asr

# 改 .env 后重建单容器
ssh ... "cd /opt/pgy-x1 && docker compose up -d --force-recreate app"

# 回滚
ssh ... "cd /opt/pgy-x1 && git log --oneline -5"
ssh ... "cd /opt/pgy-x1 && git checkout <COMMIT> && docker compose up -d --build"

# 巡检
ssh ... "df -h / && docker system df && du -sh /opt/pgy-x1/assets /root/backups"
```

切换知识版本：改 `.env` 的 `KB_RELEASE_DIR` → 确保宿主 `assets/knowledge/releases/<新tag>` 已存在 → `docker compose up -d --force-recreate app`（新 tag 无预构建索引时，首次检索会在线重建）。

---

## 11. 坑位清单

**构建 / 镜像**

- [ ] `.dockerignore` 必须排除 `.env`、`assets/`、`.kb-cache/`、`data/`（合计约 400MB）。
- [ ] `npm ci --include=dev`：运行时用 `tsx`，漏了 `--include=dev` 会得到"启动即找不到 tsx"。
- [ ] 容器以非 root 运行。
- [ ] `HEALTHCHECK` 指向真实存在的端点是 `/api/health`（不是旧平台的 `/api/health/ready`）。

**运行 / 数据**

- [ ] 只看 `127.0.0.1:8002`，绝不暴露公网端口。
- [ ] 不可再生数据（`pgy-x1_data`）有每日备份，且**演练过一次恢复**。
- [ ] **永不** `down -v`；**永不**改卷名。
- [ ] `.kb-cache` 是宿主目录，`git clean -xdf` 会删（可重建）。

**发布链路**

- [ ] 服务器用**只读** deploy key（`/root/.ssh/deploy_x1`）。
- [ ] 本地 `origin` 走 SSH；GitHub HTTPS 在本机与服务器都不稳定。
- [ ] 脚本先比对 `localHead == originHead`，再 `git pull --ff-only`。
- [ ] 构建是长命令：异步执行 + 轮询状态，别同步死等。
- [ ] 发版后跑健康检查，不能只看"容器起来了"。

**Nginx / 网络**

- [ ] SSE：`proxy_buffering off` + `proxy_cache off` + 长 `proxy_read_timeout`。
- [ ] WebSocket：`Upgrade` + `Connection "upgrade"` 两个 header 缺一不可。
- [ ] 同一端口不得重复声明同一 `server_name`（只会 warn，静默丢弃）。
- [ ] `nginx -t` 通过后再 `reload`；改配置前先 `cp` 备份。
- [ ] 仓库里的 nginx conf 与服务器实际 conf **定期 diff**（旧平台出现过漂移）。

**密钥卫生**

- [ ] SSH 私钥、API Key、`APP_SECRET`、账号密码只存在于服务器 `.env`（600）与本地 `.deploy/`、`.env`（均被 gitignore）。
- [ ] 本仓库是**公开仓库**，提交前核对：`git status` 里不出现 `.env` / `data/` / `.deploy/` / `assets/`。
- [ ] Windows 下 OpenSSH 报 `UNPROTECTED PRIVATE KEY FILE`：`icacls <key> /inheritance:r /grant:r '<用户名>:R'`。

---

## 12. 已知风险与待办

| # | 事项 | 影响 | 建议 |
|---|---|---|---|
| 1 | **443 未放行 + 域名未备案** | `https://www.pgytcm.com` 默认端口不可用，80 被阿里云拦截返回 403 | 阿里云控制台放行 443；完成 ICP 备案。临时用 `:8443` |
| 2 | 备份无异地副本 | 服务器损坏 = 账号丢失 | 配 `ossutil`/`rclone` 同步 `/root/backups` |
| 3 | 无用户管理界面 | 增删账号、改密码需走重建流程 | 后续加管理页（admin 角色已就位） |
| 4 | Docker 构建缓存约 29GB | 磁盘占用 | 定期 `docker builder prune -f`（注意会让旧平台重建变慢） |
| 5 | 知识资产不在 git | 新环境需手动同步 | 依赖 `deploy-x1.ps1 -SyncAssets` 或对象存储分发 |

---

## 13. 换到新项目：只需替换这些变量

| 类别 | 本项目取值 | 替换为 |
|---|---|---|
| 服务器 | `101.132.42.13` / `root` | 你的 ECS |
| 登录私钥 | `.deploy/pgy_deploy` | 你的 SSH 私钥 |
| 部署目录 | `/opt/pgy-x1`（目录名即 Compose 项目名） | `/opt/<项目>` |
| 服务器部署私钥 | `/root/.ssh/deploy_x1` | 你的 deploy key |
| 宿主端口 | `8002` → 容器 `8787` | 你的端口对 |
| 命名卷 | `pgy-x1_data` | `<项目>_data` |
| 域名 / 证书 | `www.pgytcm.com` / `/etc/nginx/ssl/pgytcm.com.pem` | 你的域名与证书 |
| 知识资产 | `assets/knowledge/{releases,runtime-catalog}` | 你的知识目录 |

其余（Dockerfile 结构、entrypoint 启动序、compose 数据分级、Nginx 三坑、发布脚本五段式、运维命令、坑位清单）可原样复用。
