#!/usr/bin/env pwsh
# 把 dist/ 部署到阿里云服务器（硅谷）并配置 HTTPS。
#
# 用法：
#   .\deploy\deploy-to-server.ps1 -HostName 你的域名 -ServerUser root -ServerHost 1.2.3.4
#
# 前置条件：
#   - 本地已安装 ssh / scp（Windows 10+ 自带 OpenSSH）
#   - 域名 A 记录已指向服务器 IP
#   - 服务器已开放 80 / 443（阿里云安全组 + 系统防火墙）
#   - 服务器已安装 Caddy 或 Nginx（脚本会检测）
param(
    [Parameter(Mandatory = $true)][string]$HostName,
    [Parameter(Mandatory = $true)][string]$ServerHost,
    [string]$ServerUser = 'root',
    [string]$RemotePath = '/var/www/zhengwen',
    [ValidateSet('caddy', 'nginx', 'none')][string]$WebServer = 'caddy',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipBuild) {
    Write-Host '==> 构建静态包'
    node build-static.mjs
    if ($LASTEXITCODE -ne 0) { throw '构建失败' }
}

if (-not (Test-Path 'dist/index.html')) { throw 'dist/ 不存在，请先运行 node build-static.mjs' }

$target = "${ServerUser}@${ServerHost}"

Write-Host "==> 检查服务器连通性 ($target)"
& ssh -o BatchMode=yes -o ConnectTimeout=10 $target 'echo ok' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "无法通过 SSH 连接 $target，请确认密钥已配置" }

Write-Host "==> 创建目标目录 $RemotePath"
& ssh $target "mkdir -p $RemotePath"
if ($LASTEXITCODE -ne 0) { throw '创建目录失败' }

Write-Host '==> 上传静态文件'
& scp -r -q "dist/*" "${target}:${RemotePath}/"
if ($LASTEXITCODE -ne 0) { throw '上传失败' }

# 让文件可被 Web 服务器读取，并设置合理权限
& ssh $target "chown -R www-data:www-data $RemotePath 2>/dev/null || chown -R caddy:caddy $RemotePath 2>/dev/null || true; chmod -R a+rX $RemotePath"

if ($WebServer -eq 'caddy') {
    Write-Host "==> 配置 Caddy（$HostName）"
    $caddyfile = (Get-Content 'dist/Caddyfile' -Raw) -replace 'zhengwen\.example\.com', $HostName
    $tmp = Join-Path $env:TEMP 'Caddyfile.deploy'
    Set-Content -Path $tmp -Value $caddyfile -Encoding utf8
    & scp -q $tmp "${target}:/etc/caddy/Caddyfile"
    & ssh $target 'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'
    if ($LASTEXITCODE -ne 0) { throw 'Caddy 配置失败，请检查域名解析与 80/443 端口' }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
} elseif ($WebServer -eq 'nginx') {
    Write-Host "==> 配置 Nginx（$HostName）"
    $conf = (Get-Content 'dist/nginx-zhengwen.conf' -Raw) -replace 'zhengwen\.example\.com', $HostName
    $tmp = Join-Path $env:TEMP 'zhengwen.conf.deploy'
    Set-Content -Path $tmp -Value $conf -Encoding utf8
    & scp -q $tmp "${target}:/etc/nginx/sites-available/zhengwen"
    & ssh $target 'ln -sf /etc/nginx/sites-available/zhengwen /etc/nginx/sites-enabled/zhengwen && nginx -t && systemctl reload nginx'
    if ($LASTEXITCODE -ne 0) { throw 'Nginx 配置失败，请检查域名解析与 80/443 端口' }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    Write-Host '==> 如尚未申请证书，请执行：ssh 后在服务器运行 sudo certbot --nginx -d ' + $HostName
}

Write-Host ''
Write-Host "部署完成： https://$HostName" -ForegroundColor Green
Write-Host '首次访问如提示证书错误，通常是在申请证书，等待 1–2 分钟后重试。'
