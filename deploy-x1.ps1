# deploy-x1.ps1 — 蒲公英中医 Clinical Copilot v1（X1）一键热更新（阿里云 ECS）
#
# 前置：本地已 git commit && git push origin main
# 流程：本地对齐 origin -> 服务器 git pull（增量传输）-> docker 重建 -> 健康检查
#
# 用法：
#   .\deploy-x1.ps1                # 只发代码（日常热更新）
#   .\deploy-x1.ps1 -SyncAssets    # 代码 + 知识资产（assets 不入 git，更新知识库时用）
[CmdletBinding()]
param(
    [switch]$SyncAssets
)

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $MyInvocation.MyCommand.Path
$key    = Join-Path $root '.deploy\pgy_deploy'
$remote = 'root@101.132.42.13'
$dir    = '/opt/pgy-x1'
$url    = 'https://www.pgytcm.com/'
$sshOpt = @('-i', $key, '-o', 'StrictHostKeyChecking=accept-new')

if (-not (Test-Path $key)) { throw "缺少 SSH 密钥: $key" }

function Invoke-Remote([string]$command) {
    & ssh @sshOpt $remote $command
    if ($LASTEXITCODE -ne 0) { throw "远程命令失败（exit $LASTEXITCODE）：$command" }
}

Write-Host '[deploy] [1/5] 本地代码对齐 origin/main ...'
git -C $root fetch origin main
$localHead  = git -C $root rev-parse main
$originHead = git -C $root rev-parse origin/main
if ($localHead -ne $originHead) {
    Write-Warning "本地 main($localHead) != origin/main($originHead)，请先 commit 并 push 再部署。"
    if ((Read-Host '仍要继续（部署服务器上已提交的版本）？[y/N]') -notin @('y', 'Y')) { exit 1 }
}
if (git -C $root status --porcelain) {
    Write-Warning '本地工作区有未提交改动，服务器将部署 origin/main 已提交的版本。'
}

if ($SyncAssets) {
    Write-Host '[deploy] [2/5] 上传知识资产（assets 被 .gitignore 排除，必须单独同步）...'
    $assets = Join-Path $root 'assets'
    if (-not (Test-Path $assets)) { throw "本地缺少 assets 目录：$assets" }
    # 运行时只读两处：KB_RELEASE_DIR（releases/<tag>）与 KB_RUNTIME_CATALOG_DIR（runtime-catalog）
    $envText = Get-Content (Join-Path $root 'pgy-clinical-mvp\.env') -Raw
    $releaseTag = [regex]::Match($envText, '(?m)^KB_RELEASE_DIR=.*?([^/\\\r\n]+)\s*$').Groups[1].Value
    Write-Host "        当前知识版本：$releaseTag（sources/derived/extensions 运行时不读，不同步）"
    $tgz = Join-Path $env:TEMP 'pgy-x1-assets.tgz'
    & tar -czf $tgz -C $root 'assets/knowledge/releases' 'assets/knowledge/runtime-catalog'
    & ssh @sshOpt $remote "mkdir -p $dir/assets/knowledge"
    & scp -i $key $tgz "${remote}:/tmp/pgy-x1-assets.tgz"
    Invoke-Remote "tar -xzf /tmp/pgy-x1-assets.tgz -C $dir && rm -f /tmp/pgy-x1-assets.tgz && du -sh $dir/assets"
    Remove-Item $tgz -Force
    Write-Host '        提示：知识版本切换后索引文件名随之变化，首次启动会重建索引（消耗 embedding 额度）'
} else {
    Write-Host '[deploy] [2/5] 跳过知识资产同步（需要时加 -SyncAssets）'
}

Write-Host '[deploy] [3/5] 服务器 git pull（增量传输，仅差异文件）...'
Invoke-Remote "cd $dir && git pull --ff-only origin main"

Write-Host '[deploy] [4/5] 服务器 docker 重建并启动（首次约 3-6 分钟，缓存命中约 30 秒）...'
Invoke-Remote "cd $dir && docker compose up -d --build"

Write-Host '[deploy] [5/5] 健康检查...'
Start-Sleep -Seconds 20
Invoke-Remote "cd $dir && docker compose ps"
Invoke-Remote "curl -fsS http://127.0.0.1:8002/api/health"

Write-Host ''
Write-Host "[deploy] 完成。请确认：$url（登录页 /login ／ 需账号密码）"
Write-Host '[deploy] 旧平台入口：https://101.132.42.13:8443'
