# Rome × Midscene 视觉 E2E

用 [Midscene](https://midscenejs.com/) YAML 用例对 Rome 进行视觉驱动的端到端测试。
测试运行在 Rome 的 **MSW mock 模式**（`pnpm dev:mock`）上：不访问真实后端、不使用真实个人数据，
所有断言数据都来自仓库内合成 fixture，因此用例完全确定性、可离线复现、可在 fork PR 上运行。

> 配套规划文档见 [`docs/midscene-e2e-plan.md`](../../docs/midscene-e2e-plan.md)（用例目录、mock 契约、CI 分片设计）。

## 工作原理

- `midscene.config.ts` 启动一个 Playwright Chromium，每个用例都使用**全新 BrowserContext**：
  MSW 的内存态随上下文复位，每个用例都从同一份 fixture 开始。
- 初始化脚本在应用尚无存储值时播种两项 localStorage 契约（不覆盖用例自己
  做出的选择，因此切换语言/编辑侧栏后跨导航仍保持）：
  - `rome.lang = en`：固定英文界面（避免中文 CI 机器的 locale 干扰）；
  - `rome-sidebar-pins`：展开侧栏全部内建入口（mock 用户默认只 pin 了 Apps/Chat/Projects）。
- 除 Midscene 内置 AI 节点（`aiTap`/`aiAssert`/`aiAct`/`wait` 等）外，本项目注册了 15 个确定性节点：
  `app.open`、`app.reload`、`app.goBack`、`app.expectUrl`、`app.clickContentLink`、
  `app.clickByLabel`、`app.expectControl`、`app.expectMenuItem`、`app.expectTexts`、`app.expectDom`、`app.monacoEdit`、`app.scrollContent`、
  `app.scrollTextIntoView`、`app.pressKey`、
  `app.typeText`（完整节点清单与参数见 `midscene-node-reference.md`）。
- 用例全部位于 `cases/**/*.yaml`，按套件文件组织，用 tag 标记分片与主题。

## 前置条件

- Node.js 24（仓库通过 fnm 锁定：`eval "$(fnm env)" && fnm use 24`）
- Rome 依赖已安装（仓库根目录 `pnpm install`）
- Midscene 使用的视觉模型凭据（OpenAI 兼容接口）

## 本地运行

```bash
# 1. 启动 Rome mock 模式（仓库根目录或 packages/web）
pnpm dev:mock
# 服务在 http://localhost:3200，日志默认 /tmp/rome-devmock.log

# 2. 安装测试依赖（仅首次）
cd tests/midscene
npm install
npx playwright install chromium

# 3. 配置模型凭据（仅首次；.env 已被 .gitignore，严禁提交）
cp .env.example .env
# 编辑 .env，填入 MIDSCENE_MODEL_BASE_URL / API_KEY / NAME / FAMILY

# 4. 运行全部用例
npm test
```

### 选择用例运行

通过环境变量控制 tag 过滤（在 `midscene.config.ts` 中读取）：

```bash
# 只跑 PoC 故事线
MIDSCENE_INCLUDE_TAGS=poc npm test

# 跑某个套件（一个用例可携带多个 tag）
MIDSCENE_INCLUDE_TAGS=routines npm test

# 多 tag 为 OR 关系，逗号分隔
MIDSCENE_INCLUDE_TAGS=auth,settings npm test

# 排除慢用例
MIDSCENE_EXCLUDE_TAGS=story npm test

# 调整重试次数（默认 2，CI 各分片按需要设置）
MIDSCENE_RETRY=0 npm test

# 有头模式调试
HEADLESS=false npm test
```

### Tag 约定

| Tag | 含义 |
| --- | --- |
| `poc` | 已验收的 PoC 故事线（AUTH-01、E2E-01/02/03） |
| `story` | 跨页面端到端故事线（耗时较长） |
| `auth` / `chat` / `apps` / `sessions` / `routines` / `activity` / `people` / `files` / `settings` / `shell` / `global` | 功能套件 |
| `shard-N` | CI 分片归属（N=1…6），见规划文档 |
| `zh` | 中文界面（i18n）用例 |
| `mobile` | 窄屏视口用例 |

## 报告与产物

- HTML 报告：`midscene_run/report/`
- 机器可读结果：`.midscene/test-results/<runId>/summary.json`（含收集错误详情）
- 两者均已在 `.gitignore` 中。

## 写作约定

1. **每个用例以 `app.open` 开始**，保证 fixture 复位；需要验证「刷新后」行为时才用 `app.reload`。
2. 优先用确定性节点做导航/滚动/URL 断言；`aiTap`/`aiAssert` 只承担视觉语义判断。
3. `aiAssert` 文案引用界面英文原文，并在描述里写清结构（卡片、徽章、按钮的有无）。
4. 无参自定义节点在 YAML 中必须写成 `app.goBack: {}`，否则会被解析成标量而收集失败。
5. 用例只断言仓库 fixture 中的合成数据，不引入真实人名/账号/凭据。
6. 聊天页有吸底机制：程序化滚动会被弹回，长 transcript 用 `app.scrollTextIntoView`
   （内部先发送可信 wheel 手势解除吸底）。
7. 文件浏览器（Projects/Memory）的编辑器是 Monaco，视觉操作极慢且不稳：先切到
   Edit 视图，再用 `app.monacoEdit`（经 monaco API 改值，`save: true` 等待
   PUT 完成）；按钮禁用态用 `app.expectControl` 断言，不要靠截图分辨。
8. 同名重复控件（会话页问题卡与 composer 各有一个 "Send"）用
   `app.clickByLabel: { index: n }` 按 DOM 顺序选；下拉菜单（如 composer 的
   "Reasoning effort"）的选中勾没有 `aria-checked`，用 `app.expectMenuItem`
   断言，不要让模型从截图数对勾。`app.clickByLabel` 同时覆盖 `<a>`
   （设置子导航）与 `<summary>`（Developer Settings 一类折叠区），
   跨设置页跳转、展开 disclosure 都用它而不是 `aiTap`。
9. 高度超过一个视口的长卡片/长消息（如五问设计卡、多节构建回复、Connections
   九项服务列表、Channels 会话列表），截图只能看到其中一部分：用
   `app.expectTexts: { all: [...] }` 走 DOM 校验「全文清单」，视觉断言只描述
   滚动定位后当前视口内可见的部分。
10. 已回答问题卡这类「锁定态」在截图里与可编辑态几乎无差（禁用的 fieldset
    仍渲染占位文案）：用 `app.expectDom` 断言 `fieldset[disabled]`、
    `button[aria-pressed="true"]` 数量、底部操作行按钮数等结构事实。
11. **预期会触发表单校验拦截**的步骤不要用单个 `aiAct`（模型会把「提交被
    拒绝」当成自己任务失败并重试到耗尽 replan 预算）：拆成 `app.typeText`
    （按 placeholder 或 `<label for>` 定位）+ `app.clickByLabel` 提交 +
    `app.expectTexts` 断言校验文案；补正后再次提交同理。
12. toast 渲染在 `<main>` 之外的 sonner portal，且几秒后自动消失：用
    `app.expectTexts: { scope: body }` 在触发动作后立即轮询断言 toast 文案，
    不要用 `aiAssert`（截图时 toast 常已消失）；列表/表单的持久变化另走
    默认 `scope: main` 的 DOM 断言。
13. mock 模式缺失的产品静态资源（如 desktop 工作区嵌入的
    `/desktop-vnc.html`，生产由 @rome/core 提供）在 `packages/web/mock/public/`
    补占位文件；MSW（浏览器 Service Worker）拦不住 iframe 初始文档导航
    （新 frame 还没注册 worker），这类请求必须走 dev server 静态层。
14. recorded apps（`/apps/*-*`，如 issue-triage、yt-distill）渲染在
    **open Shadow DOM** 内：视觉断言（`aiAssert`/`aiTap`）与 Playwright
    role 引擎正常工作，但 `app.expectTexts`/`app.expectDom` 基于的
    `innerText`/`main` 选择器穿不进 shadow root，这些页面不要使用这两个
    节点。
