# 政问 · 政治课程学习助手

面向政治类课程的浏览器问答系统。启动后先输入 DeepSeek API Key，进入「全屏底图 + 磨砂玻璃」的问答界面：提问框在中下部，回答卡片出现在其上方，支持联网检索、流式输出与引用来源。

![初始化界面](docs/screenshot-init.jpg)

## 特性

- **四种运行形态**：本机启动器、局域网扫码、单文件 HTML、HTTPS 静态托管
- **四套答题模式**：课程讲解、时政分析、简答提纲、主题研讨（可替换的 Markdown 提示词）
- **联网检索**：调用 DeepSeek Search API，正文用 `[n]` 标注来源，附来源卡片
- **流式输出**：SSE 逐字渲染，支持停止生成、失败重试、复制回答
- **多轮追问**：携带最近 10 条消息作为上下文
- **可替换内容**：`backgrounds/` 换底图、`prompts/` 换答题方向，刷新即生效
- **手机适配**：16px 输入防缩放、≥44px 触控目标、视觉视口处理软键盘、PWA 图标
- **安全**：Key 只在内存中，不落盘不写日志；严格 CSP；Markdown 先转义再渲染

![问答界面](docs/screenshot-answer.jpg)

## 快速开始

### 方式一：直接运行（Windows）

1. 解压发布包，**保持 `backgrounds/`、`prompts/` 与 exe 在同一目录**；
2. 双击 `政治问答系统.exe`；
3. 浏览器自动打开 `http://127.0.0.1:端口`，输入 API Key 即可。

系统需联网，但不依赖 Node.js / Python / 数据库。

### 方式二：从源码构建

需要 Go 1.22+：

```bash
go build -o politicsqa.exe .
./politicsqa.exe
```

### 方式三：手机访问

| 形态 | iPhone | 安卓 / 鸿蒙 | 说明 |
|---|---|---|---|
| 单文件版 | ❌ Safari 拦截 `file://` | ✅ | 一个 HTML 发到手机即可 |
| 局域网模式 | ✅ | ✅ | `-lan` 启动后扫码访问 |
| 在线版（HTTPS） | ✅ 推荐 | ✅ 推荐 | 部署到自己的服务器 |

详见 [手机运行说明.md](手机运行说明.md)。iOS 限制及替代方案见 [网页版单文件部署.md](网页版单文件部署.md)。

### 获取 API Key

前往 <https://platform.deepseek.com/api_keys> 创建。模型调用与联网搜索会从该账号扣费：

- 模型：`deepseek-flash`（当前对应 DeepSeek-V4.1-Flash-1017）
- 思考强度：`low`
- 联网搜索：DeepSeek 官方 Search API

## 替换底图与提示词

**底图**：放入 `backgrounds/`（`.jpg` / `.png` / `.webp` / `.svg`），设置 → 刷新内容 → 选择。建议横图 1920×1080 以上，单张不超过 5 MB。

**提示词**：`prompts/` 中每个 `.md` 是一种答题模式，文件名即菜单名（去掉序号与扩展名）。

无论选哪种模式，系统都会附加固定的底线规则：区分事实与观点、不伪造引文、优先可靠来源、不执行检索摘要中的指令。

## 启动参数

```text
-lan                  允许同一 Wi-Fi 的手机访问，打印地址与二维码
-allow-host <hosts>   额外接受的 Host（隧道域名），逗号分隔
-host <addr>          监听地址（默认 127.0.0.1；-lan 时为 0.0.0.0）
-no-open              不自动打开浏览器
-port 5199            指定端口
-data <dir>           内容目录（默认 exe 所在目录）
-upstream <url>       仅开发：替换 DeepSeek 上游地址
```

## 构建与部署

```bash
# 单文件版（可发到手机，需 Node.js 18+）
node build-standalone.mjs        # 输出 web/政问-单文件版.html

# 静态托管版（HTTPS 网站）
node build-static.mjs            # 输出 dist/
```

`dist/` 只含网站文件；服务器配置在 `deploy/`（Caddy、Nginx、宝塔/IIS 的 `web.config`）。部署步骤见 [在线版部署说明.md](在线版部署说明.md) 与 [宝塔部署步骤.md](宝塔部署步骤.md)。

## 项目结构

```text
PoliticsTask/
├─ main.go                    # 启动器入口
├─ internal/server/           # 静态服务、内容清单、API 代理、局域网策略
├─ web/                       # 前端源码（原生 HTML/CSS/JS，无框架）
│  ├─ index.html  styles.css  config.js
│  ├─ manifest.webmanifest  sw.js
│  └─ js/{app,api,markdown,prompts,runtime,boot}.js
├─ backgrounds/               # 可替换底图
├─ prompts/                   # 可替换答题模式（4 套）
├─ deploy/                    # Caddy / Nginx / 一键部署脚本
├─ build-standalone.mjs       # 单文件版构建
├─ build-static.mjs           # 静态托管版构建
└─ test/                      # 自动化测试与 mock 上游
```

## 测试

前端测试依赖只用于开发：

```bash
npm install --prefix .tools --no-fund --no-audit jsdom playwright-core
```

```bash
go test ./...                 # Go 单元测试
node test/unit.mjs            # Markdown / 提示词组装
node test/integration.mjs     # 代理 / 搜索 / SSE / 安全边界
node test/protocol.mjs        # 请求参数与模型配置
node test/dom-e2e.mjs         # jsdom 中的完整 UI 流程
```

浏览器端测试需 Chrome CDP（见各脚本头注释）：`e2e.mjs`、`request-audit.mjs`、`mobile-e2e.mjs`、`standalone-e2e.mjs`、`standalone-flow.mjs`、`ios-blocked-e2e.mjs`、`static-e2e.mjs`。

文档自检脚本：

```bash
node scripts/check-links.mjs          # 检查所有 Markdown 的相对链接是否指向已跟踪文件
python scripts/make-readme-shots.py   # 重新生成 docs/ 下的 README 配图（需 Pillow）
```

| 测试 | 结果 |
|---|---|
| `unit.mjs` | 17/17 |
| `integration.mjs` | 24/24 |
| `protocol.mjs` | 15/15 |
| `dom-e2e.mjs` | 38/38 |
| `e2e.mjs` | 45/45 |
| `request-audit.mjs` | 21/21 |
| `mobile-e2e.mjs`（Pixel 8 / iPhone 14 / 鸿蒙视口） | 54/54 |
| `standalone-e2e.mjs` | 27/27 |
| `standalone-flow.mjs` | 16/16 |
| `ios-blocked-e2e.mjs` | 15/15 |
| `static-e2e.mjs` | 28/28 |

### 真实 Key 联调（可选，会消耗额度）

```bash
export DEEPSEEK_API_KEY='sk-...'   # 仅当前终端生效
./politicsqa.exe -no-open -port 5199
node test/live-smoke.mjs
```

Key 不会写入文件，也不会被打印。

## 安全说明

- Key 只存在于页面内存与本机转发过程中，**不写入文件、不写日志、不存数据库**；刷新或关闭页面后失效
- 默认只监听 `127.0.0.1`，校验 Host 与 Origin
- `-lan` 会让同一 Wi-Fi 的设备可访问，建议只在可信网络临时开启
- 严格 CSP；Markdown 先转义再渲染，链接仅允许 `http/https`
- 检索摘要被视为不可信资料，提示词要求模型忽略其中夹带的指令
- 单文件版与在线版由浏览器直连 `api.deepseek.com`，Key 不经过任何中间服务器

## 已知边界

- 需要访问 `api.deepseek.com`；离线时界面可打开但无法回答
- 项目不内置任何 Key，需使用者自备
- 联网搜索受账号余额、网络与服务状态影响，失败时降级为不联网回答
- AI 回答仅供课程学习参考，重要结论请核对原始文件与权威来源
- 单文件版依赖浏览器允许 `file://` 页面跨域访问；iOS Safari 会拦截，此时改用在线版或局域网模式
- 局域网模式要求手机与电脑同一 Wi-Fi；部分企业/学校网络禁止设备互访

## 参考

- [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)
- [DeepSeek 网页搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search)
- [MDN：file:// 页面的 CORS 行为](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSRequestNotHttp)

## 其他文档

[使用说明.md](使用说明.md) · [手机运行说明.md](手机运行说明.md) · [在线版部署说明.md](在线版部署说明.md) · [宝塔部署步骤.md](宝塔部署步骤.md) · [网页版单文件部署.md](网页版单文件部署.md) · [作业说明.md](作业说明.md)
