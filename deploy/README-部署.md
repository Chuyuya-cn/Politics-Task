# 部署到自己的服务器（HTTPS 静态托管）

适用于：阿里云 / 腾讯云 / 任意 VPS + 自有域名。
优势：iPhone 可直接用 Safari 打开（不受 `file://` 限制），可“添加到主屏幕”，底图和提示词仍是普通文件，改完重新上传即可。

---

## 一、准备

| 项目 | 要求 |
|---|---|
| 服务器 | Linux（Ubuntu / Debian / CentOS / Alibaba Cloud Linux 均可），1 核 1G 足够 |
| 域名 | 已备案（中国大陆节点）或无需备案（硅谷等境外节点），A 记录指向服务器 IP |
| 端口 | 80、443 放行（**阿里云安全组 + 系统防火墙都要开**） |
| 本地 | Node.js 18+，用于生成静态包；Windows 自带 OpenSSH 用于上传 |

> 硅谷节点不需要 ICP 备案，直接用域名访问即可。

---

## 二、三步部署

### 1. 本地生成静态包

在项目目录运行：

```powershell
node build-static.mjs
```

生成 `dist/`，只含网站文件（`index.html`、`js/`、`styles.css`、`backgrounds/`、`prompts/`、`content.json`）。
服务器配置放在 `deploy/`，不会进入 `dist/`，避免被公网访问。

### 2. 上传并配置服务器

**方式 A：一键脚本（推荐）**

```powershell
.\deploy\deploy-to-server.ps1 -HostName 你的域名 -ServerHost 服务器IP
```

脚本会：构建 → 检测 SSH → 创建目录 → 上传 → 配置 Caddy → 申请证书 → 重载服务。

**方式 B：手动**

```bash
# 服务器上
sudo apt update && sudo apt install -y caddy
sudo mkdir -p /var/www/zhengwen

# 本地（上传网站文件）
scp -r dist/* root@服务器IP:/var/www/zhengwen/

# 服务器上：把仓库里的 Caddyfile 示例域名改成你的域名
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile     # deploy/ 需先上传到服务器
sudo sed -i 's/zhengwen.example.com/你的域名/' /etc/caddy/Caddyfile
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

> `deploy/` 目录只用于配置服务器，**不要**放进网站根目录。

### 3. 打开验证

浏览器访问 `https://你的域名`，输入 DeepSeek Key 提问。

---

## 三、用 Nginx 也行

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
# deploy/nginx-zhengwen.conf 需先上传到服务器，例如 /root/nginx-zhengwen.conf
sudo cp /root/nginx-zhengwen.conf /etc/nginx/sites-available/zhengwen
sudo sed -i 's/zhengwen.example.com/你的域名/' /etc/nginx/sites-available/zhengwen
sudo ln -sf /etc/nginx/sites-available/zhengwen /etc/nginx/sites-enabled/zhengwen
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名     # 自动申请证书并改写配置
```

> **装了宝塔面板的话，上面的 Caddy / Nginx 配置都不要用**，宝塔会接管 Nginx。
> 宝塔用户请按 [../宝塔部署步骤.md](../宝塔部署步骤.md) 在网页界面里操作。

---

## 四、为什么静态托管能解决 iPhone 问题

| | 单文件版（file://） | 静态托管（https://） |
|---|---|---|
| 页面来源 | 不透明源，Safari 拦截跨域请求 | 正常 HTTPS 源，CORS 正常工作 |
| 能否调用 DeepSeek | iOS 不行 | ✅ 可以 |
| 添加到主屏幕 | 不支持 | ✅ 支持（含图标、主题色、全屏） |
| Service Worker 离线缓存 | 不支持 | ✅ 支持 |

我把 `dist/` 用真实 Chrome 按 iPhone 视口跑过完整链路（25 项检查全过）：Key 校验、搜索、SSE 流式回答、来源引用、多轮上下文，以及 Service Worker 注册。

---

## 五、上线后必须注意

### Key 的暴露面

静态站点意味着**任何访问者都在用自己的 Key**。这本身没问题（Key 只在各自浏览器内存里），但请注意：

- **不要在代码里写死任何 Key**，`dist/` 里不含 Key；
- 不要把 `.env` 或含 Key 的文件上传到服务器；
- 如果站点是公开的，别人可以用它消耗**自己的**额度，不会动你的账号；
- 想看访问统计就在 Nginx/Caddy 日志里看，日志不含 Key。

### 内容更新

改了底图或提示词后：

```powershell
node build-static.mjs
scp -r dist/backgrounds dist/prompts dist/content.json root@服务器IP:/var/www/zhengwen/
```

只传变化的部分即可。`content.json` 必须一起更新，否则新文件不会出现在菜单里。

### 缓存

配置里对 `content.json`、`prompts/`、`sw.js` 设了 `no-cache`，改完刷新即可生效；其余静态资源缓存 1 小时。

### 成本

静态站点几乎不耗服务器资源；主要流量来自底图（建议单张 < 500 KB）和页面本身（约 120 KB）。

---

## 六、故障排查

| 现象 | 处理 |
|---|---|
| 域名打不开 / 连接超时 | 检查阿里云安全组的 80、443 是否放行；`sudo ufw status` 或 `firewall-cmd --list-all` |
| 证书申请失败 | 确认 80 端口可访问、域名解析已生效（`ping 你的域名`）；Caddy 需要 80 用于 ACME 验证 |
| 打开是空白页 | 打开开发者工具看控制台；常见原因是 `dist/` 上传不完整，缺 `js/` 或 `content.json` |
| 提示 API Key 无效 | 检查 Key 是否有效、是否复制完整；这与托管无关 |
| 提示网络错误 | 浏览器控制台看是否有 CORS 报错；确认站点是 **https** 而不是 http |
| iPhone 加不到主屏幕 | 必须 HTTPS；Safari 分享 → “添加到主屏幕” |
| 换了底图没生效 | 重新运行 `build-static.mjs`，并上传 `content.json` |

---

## 七、备选：不用自己的服务器

如果哪天不想维护服务器，同一份 `dist/` 可以直接拖到这些平台：

- **Cloudflare Pages** / **Netlify** / **Vercel**：连 Git 仓库或直接拖文件夹，自动 HTTPS；
- **GitHub Pages**：推到 `gh-pages` 分支即可（注意仓库设为公开）。

它们的限制是无法运行 `build-static.mjs` 以外的服务端逻辑——本项目本来也不需要。
