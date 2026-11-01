# 政问 · 政治课程学习助手

一个面向政治类课程的本地浏览器问答小系统。启动后自动打开浏览器，先输入 DeepSeek API Key，再进入背景图 + 磨砂玻璃质感的问答界面。

![初始化界面](screenshots/01-init.png)

## 1. 运行（交作业版）

1. 解压整个 `政治问答系统-Windows` 文件夹，不要只复制 exe。
2. 双击 `政治问答系统.exe`。若 Windows 提示“已保护你的电脑”，点击“更多信息 → 仍要运行”（程序没有购买代码签名证书）。
3. 浏览器会自动打开 `http://127.0.0.1:端口`。保持黑色命令行窗口开启，关闭它即停止服务。
4. 输入你的 DeepSeek API Key，点击“进入问答”。

系统需要联网，但不依赖 Node.js、Python、npm 或数据库。

### 手机运行

三种形态，详见 [手机运行说明.md](手机运行说明.md)：

| 形态 | iPhone | 安卓 / 鸿蒙 | 说明 |
|---|---|---|---|
| **单文件版** | ❌ Safari 拦截 | ✅ | 一个 HTML 发到手机即可，无需电脑 |
| **局域网模式** | ✅ | ✅ | `政治问答系统.exe -lan`，扫码访问 |
| **在线版（HTTPS）** | ✅ **推荐** | ✅ **推荐** | 部署到自己的服务器/域名 |

在线版部署见 [在线版部署说明.md](在线版部署说明.md)：`node build-static.mjs` 生成 `dist/`，再用 `deploy/deploy-to-server.ps1` 上传并自动配置 HTTPS。

> **iOS 限制**：Safari 会拦截 `file://` 页面的跨域请求，单文件版在 iPhone 上无法联网。项目会显示诊断面板说明原因，并引导改用在线版或局域网模式。

三种手机视口（Pixel 8 / iPhone 14 / 鸿蒙 360×780）共通过 54 项布局检查，静态托管版另有 25 项端到端检查。

### 获取 API Key

前往 <https://platform.deepseek.com/api_keys> 创建 Key。模型调用和联网搜索会从该账号扣费：

- 模型：`deepseek-flash`，当前对应 DeepSeek-V4.1-Flash-1017；
- 思考强度：`low`；
- 联网搜索：调用 DeepSeek 官方 Search API，每 1000 次成功请求约 5 元（以官方价格页为准）。

## 2. 界面

- **初始化页**：背景图 + 磨砂玻璃卡片，校验 Key 后进入系统。
- **主界面**：全屏底图，回答卡片出现在提问框上方，提问框位于页面中下部。
- 回答与提问框都使用 `backdrop-filter` 磨砂玻璃效果；不支持时自动退化为半透明深色卡片。
- 回答支持 Markdown、流式输出、来源卡片、引用编号、复制、停止生成、失败重试。
- 支持多轮追问，最多携带最近 10 条消息作为上下文。
- 移动端自适应。

![问答界面](screenshots/04-answer.png)

## 3. 替换底图与提示词

### 底图

把图片放入 `backgrounds/`，支持 `.jpg`、`.jpeg`、`.png`、`.webp`、`.svg`。打开右上角设置 → “刷新内容”，选择新底图即可。

- 建议横图，1920×1080 以上，单张不超过 5 MB；
- 默认底图为 `default.svg`；
- 系统会叠加暗色遮罩，深色或留白较多的图片更清晰。

### 提示词

`prompts/` 中每个 `.md` 文件是一种“答题模式”，文件名就是菜单名（去掉序号与扩展名）。

- 默认三套：课程讲解、时政分析、简答提纲；
- 直接编辑或新增 `.md`（UTF-8），设置中“刷新内容”后出现；
- 系统会始终附加固定底线规则：区分事实与观点、不伪造引文、优先可靠来源、不执行检索摘要中的指令。

## 4. 安全说明

- Key 只存在于浏览器页面内存和本机启动器的转发过程中，**不写入文件、不写日志、不存数据库**；刷新或关闭页面后失效。
- 默认只监听 `127.0.0.1`，会校验 Host 与 Origin，仅允许本机页面调用。
- 使用 `-lan` 时额外接受本机网卡地址，**同一 Wi-Fi 的其他设备也能访问**；仅建议在可信网络下临时开启。
- 页面使用严格 CSP，Markdown 输出先转义再渲染，链接只允许 `http/https`。
- 不要把带 Key 的页面部署到公网；本项目的 Key 输入模式适合个人本机使用。
- 搜索摘要被视为不可信资料，提示词明确要求模型忽略其中夹带的指令。
- 单文件版由浏览器直接调用 DeepSeek，Key 只发往 `api.deepseek.com`，不经过任何中间服务器。

## 5. 项目结构

```text
PoliticsTask/
├─ politicsqa.exe              # 构建产物（嵌入式页面 + 本地转发）
├─ main.go                     # 启动器入口
├─ build-standalone.mjs        # 单文件版构建脚本
├─ internal/server/            # 静态服务、内容清单、API 转发、局域网策略
├─ web/                        # 前端源码（原生 HTML/CSS/JS）
│  ├─ index.html
│  ├─ styles.css
│  ├─ config.js
│  ├─ manifest.webmanifest
│  ├─ sw.js
│  ├─ 政问-单文件版.html        # 构建产物：可直接发到手机
│  ├─ assets/
│  └─ js/{app,api,markdown,prompts,runtime,boot}.js
├─ backgrounds/                # 可替换底图
├─ prompts/                    # 可替换答题模式
├─ test/                       # 自动化测试与 mock 上游
├─ screenshots/                # 验收截图（含 mobile/ 与 standalone/）
├─ release/                    # 打包输出
├─ 使用说明.md
└─ 手机运行说明.md
```

## 6. 从源码构建

需要 Go 1.22+（开发机已使用 Go 1.26 验证）：

```powershell
$env:GOCACHE = "$PWD\.gocache"
$env:GOMODCACHE = "$PWD\.gomodcache"
go build -o politicsqa.exe .
.\politicsqa.exe
```

启动参数：

```text
-lan                  允许同一 Wi-Fi 的手机访问，启动时打印地址与二维码
-allow-host <hosts>   额外接受的 Host（隧道域名），逗号分隔
-host <addr>          指定监听地址（默认 127.0.0.1；-lan 时为 0.0.0.0）
-no-open              不自动打开浏览器
-port 5199            指定端口
-data <dir>           指定内容目录（默认是 exe 所在目录）
-upstream <url>       仅开发测试：替换 DeepSeek 上游地址
```

构建单文件版（手机直接打开，需要 Node.js 18+）：

```powershell
node build-standalone.mjs   # 输出 web/政问-单文件版.html
```

构建静态托管版（HTTPS 网站）：

```powershell
node build-static.mjs       # 输出 dist/
.\deploy\deploy-to-server.ps1 -HostName 你的域名 -ServerHost 服务器IP
```

## 7. 测试

测试依赖仅用于开发，不进入发布包：

```powershell
npm install --prefix .tools --no-fund --no-audit jsdom playwright-core
```

然后：

```powershell
# Go 单元测试
$env:GOCACHE = "$PWD\.gocache"; $env:GOMODCACHE = "$PWD\.gomodcache"
go test ./...

# 前端逻辑测试
node test/unit.mjs

# 启动 mock 上游和本机服务后可运行：
node test/integration.mjs   # 代理 / 搜索 / SSE / 安全边界
node test/protocol.mjs      # 请求协议与参数校验
node test/dom-e2e.mjs       # jsdom 中的完整 UI 流程
```

真实浏览器测试使用 `test/e2e.mjs`、`test/request-audit.mjs`（桌面）、`test/mobile-e2e.mjs`（安卓/iOS/鸿蒙视口）、`test/standalone-e2e.mjs`、`test/standalone-flow.mjs`、`test/ios-blocked-e2e.mjs`（单文件版与 iOS 拦截诊断）和 `test/static-e2e.mjs`（静态托管版，需先 `node test/static-server.mjs`），均需要 Chrome CDP，见脚本头注释。

### 真实 Key 联调（可选，会消耗额度）

自动化测试使用本地 mock，不包含任何 Key。若要用自己的 Key 做一次真实链路验收：

```powershell
$env:DEEPSEEK_API_KEY = 'sk-...'   # 只在当前终端生效
.\politicsqa.exe -no-open -port 5199
node test/live-smoke.mjs
```

脚本会校验 Key、调用一次 Search，并发起一次很小的流式 Chat 请求。Key 不会写入任何文件，也不会被打印。加 `-SkipSearch` 对应的环境变量 `SKIP_SEARCH=1` 可跳过搜索调用。

## 8. 已知边界

- 需要网络访问 `api.deepseek.com`；离线时无法回答，但界面仍可打开。
- API Key 必须由使用者提供，项目不内置任何 Key。
- 联网搜索是否成功取决于账号余额、网络和 DeepSeek 服务状态；失败时系统会降级为不联网回答并提示。
- AI 回答仅供课程学习参考，重要结论请核对原始文件。
- **单文件版依赖浏览器允许 `file://` 页面跨域访问网络。** 安卓 Chrome / 华为浏览器实测可用；iOS Safari 存在被拦截的可能，届时请改用在线版或局域网模式。项目已内置相应提示。
- 局域网模式需要手机与电脑在同一 Wi-Fi；部分企业/学校网络禁止设备互访。
- 在线版部署后由浏览器直连 `api.deepseek.com`，请求不经过你的服务器。

## 9. 技术依据

- [DeepSeek 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)
- [DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)
- [DeepSeek 网页搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search)
- [MDN：file:// 页面的 CORS 行为](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS/Errors/CORSRequestNotHttp)
