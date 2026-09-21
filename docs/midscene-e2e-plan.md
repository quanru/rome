# Rome Midscene 用例规划

> 面向 Rome 维护者的接入方案附件。文末附英文摘要（English summary）。
>
> 状态：第 5 节目录中的 91 个 ✅ 用例已全部落为 `tests/midscene/cases/` 下的 YAML，按 6 个 CI 分片（14/15/14/20/17/11）组织，并已在本地 mock 模式**全量 91/91 跑通**（含 PoC：AUTH-01、E2E-01/02/03）。

## 1. 背景与目标

Rome 是一个以对话为中心、集成例程（routines）、审批（approvals）、活动流（activity）、安装式应用（apps）等能力的个人 AI 操作系统。它的产品体验大量由**富交互卡片**与**跨页面状态联动**构成——例程从聊天里被提议、一键启用、落在 Routines 页；审批在聊天卡片里完成、同步到 Activity；聊天中的应用链接在工作区侧旁 tile 打开并出现在 Apps 安装列表。

这类体验有两个特点：

1. **传统选择器测试脆弱**：卡片结构、动画、流式渲染、虚拟布局变化频繁；
2. **真实后端不可测**：功能依赖个人账号、IM 渠道（telegram/whatsapp）、第三方服务，CI 中无法稳定复现。

本方案用 [Midscene](https://midscenejs.com/) 的视觉语义驱动解决第 1 点，用 Rome 自带的 **MSW mock 模式**（`pnpm dev:mock`）解决第 2 点：所有用例只针对仓库内合成 fixture 运行，无需真实账号、无外部副作用、可在 fork PR 上复现。

目标：

- 为 Rome 的核心产品故事建立**可长期守护**的视觉 E2E 基线；
- 作为 Midscene CI 向开源项目推广的参考实现（确定性夹具 + 视觉语义断言 + 分片 CI）；
- 全部用例可离线、重复运行，单次执行互不污染。

## 2. 总体架构

```
GitHub Actions (6 shards)
  └─ pnpm --filter rome-web dev:mock        # MSW mock 模式，localhost:3200
       └─ tests/midscene (独立 npm package)
            ├─ midscene.config.ts           # Playwright + Midscene 项目配置
            ├─ cases/**.yaml                # 用例（套件 + tag 分片）
            └─ Playwright Chromium (1440×900, en-US)
                 └─ 每用例全新 BrowserContext
                      ├─ localStorage: rome.lang=en
                      ├─ localStorage: rome-sidebar-pins=<全集>
                      └─ MSW 内存态随上下文复位
```

### 2.1 为什么是独立 npm package

`tests/midscene` 位于 pnpm workspace glob（`packages/*`、`rome_apps/*`、`example_apps/*`）之外，使用独立 `package-lock.json` 安装 `@midscene/test`、`@midscene/web` 与 `playwright`：

- Midscene 的依赖树不进入 Rome 产品依赖，不影响线上构建；
- CI 中测试依赖与产品依赖分开缓存；
- `npm ci` 非交互安装，`esbuild`/`sharp` 的安装脚本已通过 package.json `allowScripts` 显式批准。

### 2.2 测试基座（midscene.config.ts）

- **每用例全新 BrowserContext**：MSW handler 挂在 Service Worker 风格的 `setupWorker` 上，写操作保存在内存；新上下文 = 冷启动 = fixture 复位。用例之间零共享状态。
- **语言固定英文**：初始化脚本写入 `rome.lang=en`，避免中文 CI 机器探测出 zh-CN 导致文案漂移。另设 `zh` tag 的中文界面专用用例。
- **侧栏 pin 全集注入**：mock guardian 默认只 pin Apps/Chat/Projects，其余入口藏在 "all apps" 弹层里。用例通过写入 `rome-sidebar-pins`（shell 自身的 localStorage 契约）展开全部内建入口，跨页故事的侧栏点击因此确定可用。
- **AI 节点 + 确定性节点分层**：导航、URL、滚动等机械操作使用 10 个自定义 Playwright 节点，视觉语义判断才交给 `aiTap`/`aiAssert`，显著降低耗时与波动。
- **环境变量驱动选择执行**：`MIDSCENE_INCLUDE_TAGS` / `MIDSCENE_EXCLUDE_TAGS`（逗号分隔，OR 语义）、`MIDSCENE_RETRY`、`HEADLESS`，本地单用例迭代与 CI 分片共用同一入口。

自定义节点（完整清单与参数见 `midscene-node-reference.md`）：

| 节点 | 作用 |
| --- | --- |
| `app.open` | 新上下文打开路由，注入语言/pin，等待侧栏或登录页就绪 |
| `app.reload` | 硬刷新（内存态复位为默认 fixture，用于验证"刷新后"行为） |
| `app.goBack` | 浏览器后退（客户端导航，**保留**内存态） |
| `app.expectUrl` | URL 子串/`re:` 正则断言 |
| `app.clickContentLink` | 在侧栏之外按链接文本确定性点击（规避侧栏同名链接歧义） |
| `app.clickByLabel` | 按 accessible name 确定性点击重复的图标按钮（tile kebab、chip 清除等，穿透 open shadow DOM） |
| `app.pressKey` | 确定性键盘快捷键（`mod` 在 macOS→⌘、其他→Ctrl，兼容本地与 Linux CI） |
| `app.typeText` | 按 placeholder/label 定位字段后键盘输入，支持只清空（`clear: true` 无 `text`） |
| `app.scrollContent` | 主内容区（含 shadow DOM 录制应用与窗口级滚动页如 Sessions）滚到顶/底，二次设定 |
| `app.scrollTextIntoView` | 先发送可信 wheel 手势解除聊天吸底，再把含指定文本的元素滚到视口中央；穿透 shadow DOM |

## 3. Mock 模式契约（用例作者必读）

所有用例都依赖以下行为事实；这些是**对现有实现的记录**，若实现改变，用例需同步。

1. **冷启动状态固定**：`/api/health`、`/api/bootstrap`、`/api/auth/me` 使应用直接进入已登录 shell，guardian 为合成用户；浏览器一打开就是认证态。
2. **写操作只在内存**：POST/PATCH 类操作（如启用 routine、批准审批、安装应用）写入 MSW 内存，在**同一 BrowserContext 的客户端路由之间保持**；硬刷新、关闭上下文或新开上下文即恢复 fixture 默认值。
3. **未被 handler 匹配的请求 bypass MSW**：访问未 mock 的能力会打到网络并失败，用例不得依赖此类能力（列入第 6 节缺口）。
4. **用例只允许使用合成 fixture 数据**：不得引入真实人名、账号、token、聊天内容。
5. **等待策略**：`app.open` 的 shell 等待（侧栏 `a[href="/chat"]` 出现）同时表示 mock 就绪；卡片挂载后的异步 settle（如 routine 卡片重新 `GET /api/routines`）用显式 `wait` 等待。
6. **聊天吸底**：transcript 默认吸附最新消息，程序化滚动会被 `useStickToBottom` 弹回；只有可信手势（wheel/touch/键盘）后 300ms 窗口内的 scroll 能解除吸底——这一封装已内置于 `app.scrollTextIntoView`。
7. **聊天内应用链接**：markdown 中 `/apps/<id>` 链接由 `ChatLink` 拦截，在工作区侧旁 tile 打开，URL 保持在 `/chat/...`；这是真实产品行为，用例按 tile 断言而非路由跳转。

## 4. CI 设计（.github/workflows/midscene.yml）

- **触发**：push main / PR（路径覆盖 `tests/midscene/**`、整个 `packages/web/**` 以及 build:kit 会重建的 workspace 依赖 `packages/ui`、`packages/web-content`、`packages/api-types`、`packages/app-runtime-sdk`）/ 手动；fork PR 与 Dependabot PR 不获取模型密钥，由显式的 `visual-e2e-skip` 作业标注跳过原因。
- **运行环境**：`ubuntu-24.04` + Node 24 + pnpm 11.6.0（corepack）；`pnpm install --frozen-lockfile --ignore-scripts` 安装产品依赖，`tests/midscene` 下 `npm ci`（lockfile 全部 resolved 指向公共 `registry.npmjs.org`，干净 runner 可直接安装）+ `npx playwright install --with-deps chromium`。
- **服务**：`pnpm --filter rome-web dev:mock` 后台启动（先跑 `build:kit`，就绪探测最长 360s 轮询 `http://localhost:3200/`），日志落 `/tmp/rome-devmock.log`，失败时随 artifact 上传。
- **密钥与信任边界**：`MIDSCENE_MODEL_API_KEY/NAME/BASE_URL/FAMILY` 经 secrets 注入，且只挂在「配置校验 / 连通性预检 / 跑用例」三个步骤上（安装与起服务不接触密钥）。PR 检出的是贡献者可控代码，作业走受保护环境 **`midscene-e2e-review`**——维护者批准该 environment deployment 后 runner 才启动、密钥才暴露；push main 与手动触发走 **`midscene-e2e`** 环境（无需审批）。仓库需预先配置这两个 environment 与四个 secret。作业开头做非空校验与一次 `/chat/completions` 连通性预检（90s 超时），密钥/端点问题在 30 秒内失败而不是跑满 45 分钟。
- **分片**：6 个 matrix shard，通过 `MIDSCENE_INCLUDE_TAGS=shard-N` 选择；每个用例恰好携带一个 `shard-N` tag。`fail-fast: false`、`max-parallel: 6`、单作业 45 分钟、用例级重试 2 次。
- **证据**：每个分片始终上传 `midscene_run/` 与 `.midscene/` 报告 artifact（保留 14 天）；失败时附加 mock server 日志。
- **网络稳定性**：`NODE_OPTIONS=--dns-result-order=ipv4first --no-network-family-autoselection`（模型端点仅 IPv4 稳定，规避 runner 侧 IPv6 竞速超时）。
- **可选项（后续）**：报告汇聚后发布 GitHub Pages 历史报告——可复用 Midscene 官方/参考实现的 report-bundle + deploy reusable workflow，需要 Rome 侧另加报告构建脚本，本期不纳入。

分片划分（按实测耗时与模块聚合，6 片并行墙钟约 8–12 分钟）：

| Shard | 用例数 | 内容 |
| --- | --- | --- |
| shard-1 | 14 | chat 核心：首页、会话列表、composer、基础 transcript |
| shard-2 | 15 | chat 富卡片（7）+ apps（7）+ E2E-03 安装故事 |
| shard-3 | 14 | sessions（7）+ routines（5）+ E2E-01/02 故事线 |
| shard-4 | 20 | activity（6）+ people（6）+ files/memory（8） |
| shard-5 | 17 | settings（11）+ auth（3）+ SHELL-01/04/06 |
| shard-6 | 11 | recorded apps 深度走查（5）+ SHELL-02/03/05/07 + GLOBAL-01/02（含 i18n、mobile） |

PoC 故事线同时携带所属分片 tag（E2E-01/02→shard-3，E2E-03→shard-2，AUTH-01→shard-5）。

## 5. 用例目录

> 用例 ID 规则：`<套件>-<序号>`；✅ = mock 可驱动（本期全部起草），⚠️ = 依赖第 6 节的 mock 缺口（仅登记，不落 YAML）。

<!-- CASE-CATALOG -->
本期共落地 **91 个** ✅ mock 可驱动用例（15 个 YAML 文件），按套件分组；Shard 列为 CI 分片归属。

### auth-shell（12，shard-5/6）

| ID | 用例 |
| --- | --- |
| AUTH-01 | Mock guardian 打开根路由直接进入聊天首页 |
| AUTH-02 | `/dev/login` 本地登录表单渲染与必填校验 |
| AUTH-03 | 登录表单提交命中通用错误 "Login failed"（未 mock 的 login 写接口） |
| SHELL-01 | 侧栏入口可导航到每一个内建页面 |
| SHELL-02 | ⌘/Ctrl+K 打开聊天搜索并命中会话 |
| SHELL-03 | ⌘/Ctrl+B 折叠/展开侧栏 |
| SHELL-04 | 编辑模式移除 pin、Add 恢复 pin |
| SHELL-05 | 移动视口下侧栏变为可关闭抽屉（`mobile`） |
| SHELL-06 | 账号菜单展示身份与账号操作 |
| SHELL-07 | mock 模式不支持登出，给出错误 toast |
| GLOBAL-01 | 未知路由静默跳转聊天首页 |
| GLOBAL-02 | 切换中文后整个 shell 本地化（`zh`） |

### chat（21，shard-1/2）

| ID | 用例 |
| --- | --- |
| CHAT-01 | 首页 composer 的 placeholder、上传、项目与 reasoning 控件 |
| CHAT-02 | Reasoning effort 菜单含 Fast / Think / Ultrathink |
| CHAT-03 | 项目选择器列出项目与新建入口 |
| CHAT-04 | 首页 composer 发送在无后端时给出明确失败 |
| CHAT-05 | 会话内发送失败且不丢失草稿 |
| CHAT-06 | 斜杠 skill 菜单加载并报告不可用状态 |
| CHAT-07 | @ agent 选择器提供两个 fixture agent |
| CHAT-08 | 最近会话按日期分组（curated + older） |
| CHAT-09 | 从侧栏打开会话加载 transcript |
| CHAT-10 | 成功 tool trace 可从折叠摘要展开 |
| CHAT-11 | 失败 turn trace 展示模型供应商错误 |
| CHAT-12 | 子 agent 委派 trace 展示其 recorded-not-available 状态 |
| CHAT-13 | 有用反馈可提交并记录 |
| CHAT-14 | Copy message 复制纯文本助手消息 |
| CHAT-15 | 已回答的设计问题卡锁定所选答案 |
| CHAT-16 | 建应用最终回复的章节与可折叠 mermaid 图 |
| CHAT-17 | 学习包链接在工作区 tile 打开 YouTube Distill |
| CHAT-18 | 训练计划链接在 tile 打开 Fitness Tracker |
| CHAT-19 | 市场复盘链接在 tile 打开 Stock Daily 指定报告 |
| CHAT-20 | 实时问题卡答全前 Send 禁用，提交给出设计内失败 |
| CHAT-21 | 拒绝 plumber 审批后卡片变为 rejected |

### apps（13，shard-2/6）

| ID | 用例 |
| --- | --- |
| APPS-01 | Installed apps 网格列出 5 个 fixture 应用与内建应用 |
| APPS-02 | 搜索收窄网格（"1 result"） |
| APPS-03 | 无匹配搜索的空状态文案 |
| APPS-04 | tile 菜单 Disable/Enable 即时切换 |
| APPS-05 | Uninstall 确认对话框与卸载后计数/toast |
| APPS-06 | 应用详情页 manage 行与 capability 卡片 |
| APPS-07 | 未知 store handle 的安装页 not-found 态 |
| RAPP-01 | Issue Triage 录制面板（Repos/Triaged/Succeeded/Failed + #363） |
| RAPP-02 | YouTube Distill 录制记录与 15 节思维导图 |
| RAPP-03 | Code Review 录制 PR 评审（timeline + Verdict + Findings P1–P3） |
| RAPP-04 | Fitness Tracker 周计划与 beginner/20min 设置 |
| RAPP-05 | Stock Daily 周频调度与完整日报（章节 1/4/8） |
| E2E-03 | 从聊天链接打开已建应用并在 Apps 中找到它（`story`） |

### sessions（7，shard-3）

| ID | 用例 |
| --- | --- |
| SES-01 | 列表列、类型徽章与分页（7 天窗口 13 行） |
| SES-02 | 跨标题/上下文搜索（All time 下 plumber 命中 3 行） |
| SES-03 | Type facet 过滤为 Channel 并显示可清除 chip |
| SES-04 | 时间范围切到 All time 后扩为 22 行 |
| SES-05 | 无匹配搜索的 "No sessions found" 空状态 |
| SES-06 | Channel 会话只读详情与 Details 抽屉（Technical details） |
| SES-07 | Webchat 会话详情的 Open chat 回到对话 |

### routines（6，shard-3）

| ID | 用例 |
| --- | --- |
| ROUT-01 | 汇总卡（Total/Active/Paused/Next up）、分组、计划与开关 |
| ROUT-02 | Calendar 月视图与 recurring/one-time 图例 |
| ROUT-03 | Timeline 按时间轴排列即将到来的运行与动作名 |
| ROUT-04 | Create Routine 对话框的三种 trigger 类型 |
| ROUT-05 | 开关 on-demand routine 即时更新 Active/Paused 计数 |
| E2E-01 | 聊天里启用 routine 并在 Routines 页验证（`story`） |

### activity（7，shard-3/4*）

| ID | 用例 |
| --- | --- |
| ACT-01 | Live 指示、计数 chips、待审批横幅与状态筛选 |
| ACT-02 | 三个渠道接入请求与验证码配对指引 |
| ACT-03 | Running 筛选隔离唯一执行中的动作并可 Cancel |
| ACT-04 | 在 Activity 拒绝 send_message 审批后横幅减一 |
| ACT-05 | webhook 投递的 Payload JSON 可展开 |
| ACT-06 | Error 筛选列出 3 个失败执行与 Details |
| E2E-02 | 聊天批准 send_message 并在 Activity 验证（`story`） |

> *E2E-02 同时挂 `activity` 主题 tag，分片在 shard-3（与 E2E-01 同片）。

### people（6，shard-4）

| ID | 用例 |
| --- | --- |
| PPL-01 | Latest 最近会话预览 |
| PPL-02 | Directory 按 bond 分组（Inner circle/Acquaintance/Other）与计数 |
| PPL-03 | bond 筛选 chip 收窄目录 |
| PPL-04 | 人物详情的消息时间线、渠道标签与 composer |
| PPL-05 | 时间线渠道筛选（WhatsApp / All） |
| PPL-06 | 人物操作菜单（Change bond / Link account / Merge / Memory profile） |

### files / memory（8，shard-4）

| ID | 用例 |
| --- | --- |
| FILE-01 | projects 文件树根目录与右栏 dashboard 的未 mock 错误态 |
| FILE-02 | 只读查看 demo-app/README.md |
| FILE-03 | 编辑 todo.md 后内存态跨文件切换保持 |
| FILE-04 | 新建文件出现在树中 |
| FILE-05 | 重名重命名命中 409 "Already exists." |
| FILE-06 | memory 树的 journal/projects/relationship 与 BONDS.md |
| FILE-07 | 今日 journal 按日期路径存在 |
| FILE-08 | memory 笔记编辑后跨文件保持 |

### settings（11，shard-5）

| ID | 用例 |
| --- | --- |
| SET-01 | /settings 跳转 Appearance 并暴露六个标签页 |
| SET-02 | Appearance 即时切换深色 |
| SET-03 | Connections 列出九个 fixture 连接 |
| SET-04 | 断开连接授权后卡片即时变化（刷新复位） |
| SET-05 | App keys 新建的输入校验与保存 |
| SET-06 | Channels 会话激活卡片与单个会话配置 |
| SET-07 | AI Tools 显示 Claude 连接状态/用量与登出 |
| SET-08 | Favors 余额、待决策与账本 |
| SET-09 | Advanced 访问控制、computer use 与开发者开关 |
| SET-10 | 添加允许的 dashboard 邮箱并 toast |
| SET-11 | 开发者开关经 PUT /api/settings 保存并跨导航保持 |

### ⚠️ 依赖第 6 节 mock 缺口、暂不落 YAML 的候选

| 主题 | 候选用例 | 阻塞 handler |
| --- | --- | --- |
| chat | 真实发消息往返、流式回复、问题卡提交成功态 | turn SSE |
| sessions | /sessions Overview 指标页（成功率/耗时图表） | sessions metrics |
| projects | 项目右栏 dashboard 汇总渲染 | projects dashboard |
| chat/sessions | 会话 fork、分享链接、归档/删除成功路径 | fork/share/archive |
| settings/activity | 新渠道连接向导、连接请求 Approve 成功态 | connection setup |

## 6. Mock 缺口与建议上游补充的 handler

下列产品能力当前 mock 未覆盖，是 ⚠️ 用例的阻塞点。建议 Rome 在 `packages/web/mock/handlers/` 补充 5 个 handler（合成数据、内存态，与现有风格一致）：

<!-- MOCK-GAPS -->
以下均建议沿用现有 handler 风格：**合成 fixture + 内存写入 + 冷启动复位**，与真实外部服务零交互。

### 1. Chat turn 流式接口（SSE）

- **现状**：发送消息与提交问题/审批卡片共用 `POST /api/.../turns`，mock 未提供；前端只能走到 "Failed to send message"。CHAT-04/05/20 因此断言的是设计内失败态。
- **建议**：新增 turn handler，接收合成 prompt 后以 SSE 返回一段固定的合成回复流（message-start → 若干 content delta → tool/卡片 block → done），支持一个预置「问题卡答复」和「审批执行完成」分支。
- **解锁**：发送成功往返、流式打字过程断言、问题卡提交后的锁定成功态、发送中/停止按钮状态。

### 2. Sessions Overview 指标接口

- **现状**：`/sessions`（Overview 分段）依赖 `POST /api/sessions/metrics`，未 mock 时整页不可用；所有 sessions 用例只能落在 `/sessions/all`。
- **建议**：基于现有 sessions fixture 聚合返回固定窗口指标（运行数、成功率、token/费用合计、按天/按类型分布）。
- **解锁**：Overview 页图表/汇总渲染、时间窗口联动、metrics 与列表一致性断言（约 3–4 个 ⚠️ 用例）。

### 3. Projects dashboard 接口

- **现状**：`/projects` 左栏文件树全部可用，但右栏 dashboard 的汇总请求未 mock，固定显示 "Network error / Retry"（FILE-01 已把该现状固化为基线）。
- **建议**：返回 fixture 项目的合成摘要（最近文件、活动、用量等静态聚合）。
- **解锁**：dashboard 正常渲染、文件选择与摘要联动、Retry 在恢复后消失。

### 4. 会话 fork / 分享 / 归档

- **现状**：会话的创建（fork）、分享链接、归档/删除等写操作没有对应 handler，只能验证失败文案。
- **建议**：为会话写操作补内存态 handler：fork 生成新 id 的会话副本；share 颁发合成只读链接（固定 token）；archive/delete 从列表移除并可在内存中恢复。
- **解锁**：fork 后新会话内容继承、分享页只读渲染、归档后列表消失/视图筛选、删除确认链路。

### 5. 渠道连接 setup（接入向导与审批）

- **现状**：Activity 中三条渠道连接请求（Telegram/Discord/Feishu）可渲染、可 Reject，但 Approve 与设置内的「新渠道接入向导」没有成功路径 handler。
- **建议**：连接请求 Approve 写入内存并返回配对码/成功态；补一个向导的多步 GET/POST（选渠道 → 生成验证码 → 验证 → 完成），全程合成。
- **解锁**：Approve 成功后请求消失、横幅计数减少；新渠道向导完整走查；连接卡片出现在 Channels/Settings 中。

### 已在本方案落地的 mock 基建补充

- **文件浏览器 watch SSE**（`packages/web/mock/handlers/file-browser.ts`）：补了 `/events` SSE 流（subscribers/emit/ready，事件镜像前端的 chokidar watch 事件），mock 内 POST/PATCH/DELETE 写入后即时推送 `add`/`addDir`/`change`，前端文件树不再需要整页刷新就能看到写入结果（files/memory 用例依赖）。
- **Desktop 工作区占位文档**（`packages/web/mock/public/desktop-vnc.html`）：Browser 工作区 iframe 嵌入的 noVNC 文档生产由 @rome/core 提供；mock 模式下该静态资源缺失会被 SPA fallback 成嵌套的 /chat。在 dev server 静态层补了一个空白深色占位页（MSW Service Worker 拦不住 iframe 初始文档导航，必须走静态层），SHELL-01 据此断言「空白嵌入式桌面」。

## 7. 本地运行

见 `tests/midscene/README.md`。简述：

```bash
pnpm dev:mock                    # 终端 1：localhost:3200
cd tests/midscene
npm install && npx playwright install chromium
cp .env.example .env             # 填入模型凭据；.env 不入库
npm test
MIDSCENE_INCLUDE_TAGS=poc npm test   # 只跑 PoC
```

## 8. 写作与维护约定

1. 每个用例以 `app.open` 开始；只有验证"刷新后"行为才用 `app.reload`；验证跨页联动用 `aiTap` 侧栏 + `app.goBack`（保留内存态）。
2. 机械操作（导航/URL/滚动/同名链接）一律用自定义节点；视觉语义才用 AI 节点。AI 断言引用英文界面原文，并写明元素的**有/无**（如"按钮消失"）。
3. YAML 中无参自定义节点写成 `app.goBack: {}`。
4. 一个用例恰好一个 `shard-N` tag；功能 tag（chat/routines/…）按需多个。
5. 新增用例必须能在全新上下文重复通过；禁止用例间依赖。
6. fixture 变更时同步更新用例断言；新增产品能力时先补 mock handler 再补 ⚠️ 用例。

---

## English Summary

This document proposes visual E2E for **Rome** using [Midscene](https://midscenejs.com/) YAML cases driven against Rome's built-in **MSW mock mode** (`pnpm dev:mock`, port 3200). Everything runs against synthetic in-repo fixtures: no real accounts, messaging channels, or personal data are used, and the suite is deterministic and repeatable on forks.

Key design points:

- Tests live in `tests/midscene/`, a standalone npm package outside the pnpm workspace globs, pinning `@midscene/test` and Playwright.
- Each case gets a **fresh BrowserContext**, which resets in-memory MSW state; init scripts pin `rome.lang=en` and the full set of sidebar pins so every case starts identically.
- Ten deterministic custom nodes (`app.open`, `app.reload`, `app.goBack`, `app.expectUrl`, `app.clickContentLink`, `app.clickByLabel`, `app.scrollContent`, `app.scrollTextIntoView`, `app.pressKey`, `app.typeText`) cover navigation, URL assertions, scrolling, keyboard and field input; AI nodes are reserved for visual-semantic checks.
- CI is a 6-shard GitHub Actions matrix on Node 24 / pnpm 11.6, starts the mock dev server, validates model secrets and connectivity before running, and uploads per-shard HTML reports plus server logs.
- The four PoC stories (AUTH-01, E2E-01 routines, E2E-02 approvals, E2E-03 built app) pass locally; the full catalog now holds 91 mock-drivable YAML cases across auth-shell, chat, apps, sessions, routines, activity, people, files/memory and settings.
- Five mock handlers are suggested upstream (chat turn streaming, session metrics, projects dashboard, fork/share/archive, connection setup) to unblock the remaining backlog.
