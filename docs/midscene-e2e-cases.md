# Rome · Midscene E2E 用例总览

> 评估对象：[Rome](https://github.com/rome-os/rome)
> 用例位置：`tests/midscene/cases/`
> 运行模式：本地 **MSW mock 模式**（合成 fixture，无真实后端 / 凭据）
> 最近结果：**91 / 91 全部通过，MIDSCENE_RETRY=0（禁用重试，首轮一次通过）**
> 更新日期：2026-09-21

---

## 一、总体情况

- 共 **91 个**用例，组织在 13 个 YAML 文件中，按产品模块划分。
- 每个用例由「视觉断言（aiAssert / aiTap）+ 确定性节点（app.* 自定义节点）」混合驱动，覆盖页面渲染、交互流转、表单校验、toast、跨页持久化、响应式等场景。
- CI 按 6 个 shard 并行，标签直接打在每个用例上：

| 分片 | 用例数 | 主要内容 |
|---|---|---|
| shard-1 | 14 | 聊天核心（composer、trace、反馈、复制） |
| shard-2 | 15 | 应用管理 7、聊天卡片 7、端到端故事 1 |
| shard-3 | 14 | 会话列表 7、例行任务 5、端到端故事 2 |
| shard-4 | 20 | 动态流 6、文件/记忆 8、人脉 6 |
| shard-5 | 17 | 设置 11、登录鉴权 3、外壳导航 3 |
| shard-6 | 11 | 录制应用 5、外壳/全局 6 |
| **合计** | **91** | |

---

## 二、按模块分类的用例清单

### 1. 聊天核心 Chat（`chat-core.yaml`）— shard-1，14 个

| ID | 用例 |
|---|---|
| CHAT-01 | Home composer shows placeholder, upload, project and reasoning controls |
| CHAT-02 | Reasoning effort menu offers Fast, Think and Ultrathink |
| CHAT-03 | Project selector lists projects and a create entry |
| CHAT-04 | Sending from the home composer fails clearly without a backend |
| CHAT-05 | Sending inside a conversation fails without removing the draft |
| CHAT-06 | Slash skill menu loads and reports its unavailable state |
| CHAT-07 | Agent mention picker offers the two fixture agents |
| CHAT-08 | Recent chats are grouped by date with curated and older fixtures |
| CHAT-09 | Opening a conversation from the sidebar loads its transcript |
| CHAT-10 | Successful tool trace opens from the collapsed summary |
| CHAT-11 | Failed turn trace surfaces the model provider error |
| CHAT-12 | Subagent delegation trace shows its recorded-not-available state |
| CHAT-13 | Helpful-turn feedback submits and records |
| CHAT-14 | Copy message copies a plain-text assistant turn |

### 2. 聊天富卡片 Chat Blocks（`chat-blocks.yaml`）— shard-2，7 个

| ID | 用例 |
|---|---|
| CHAT-15 | Answered design question card is locked with chosen answers |
| CHAT-16 | Built-app reply renders sections and a collapsible mermaid diagram |
| CHAT-17 | Learning kit links open YouTube Distill in a workspace tile |
| CHAT-18 | Workout plan links open Fitness Tracker in a workspace tile |
| CHAT-19 | Market recap links open a specific Stock Daily report tile |
| CHAT-20 | Live question card enables Send only after required answers |
| CHAT-21 | Rejecting the plumber approval resolves the card as rejected |

### 3. 应用管理 Apps（`apps.yaml`）— shard-2，7 个

| ID | 用例 |
|---|---|
| APPS-01 | Installed apps grid lists the five fixture apps and built-in entries |
| APPS-02 | Search narrows the apps grid |
| APPS-03 | Search without matches shows the empty state |
| APPS-04 | Disable an app from its tile menu and re-enable it |
| APPS-05 | Uninstall an app through the confirmation dialog |
| APPS-06 | App details page renders manage rows and capability cards |
| APPS-07 | Installing an unknown store handle shows the not-found state |

### 4. 录制应用 Recorded Apps（`recorded-apps.yaml`）— shard-6，5 个

> 这些应用渲染在 open Shadow DOM 中，是产品内置的「录制回放」演示应用。

| ID | 用例 |
|---|---|
| RAPP-01 | Issue Triage dashboard shows repository and recent triage results |
| RAPP-02 | YouTube Distill opens the recorded talk with its mind map |
| RAPP-03 | Code Review dashboard opens the recorded PR review with verdict |
| RAPP-04 | Fitness Tracker shows the weekly plan and beginner settings |
| RAPP-05 | Stock Daily shows the weekday schedule and a full report |

### 5. 会话 Sessions（`sessions.yaml`）— shard-3，7 个

| ID | 用例 |
|---|---|
| SES-01 | Sessions list renders the fixture rows with columns and pagination |
| SES-02 | Search filters sessions across title and context |
| SES-03 | Facet filter restricts to Channel sessions and shows a filter chip |
| SES-04 | Time range selector widens the list to all-time sessions |
| SES-05 | Empty result state for an unmatched search |
| SES-06 | Channel session detail shows read-only header and Details sheet |
| SES-07 | Webchat session detail offers Open chat back to the conversation |

### 6. 例行任务 Routines（`routines.yaml`）— shard-3，5 个

| ID | 用例 |
|---|---|
| ROUT-01 | Routines list shows totals, groups, schedules and switches |
| ROUT-02 | Calendar view renders the month with run markers |
| ROUT-03 | Timeline view orders upcoming schedule runs on a time axis |
| ROUT-04 | Create Routine dialog explains the three trigger types |
| ROUT-05 | Toggling the on-demand routine updates the active count |

### 7. 动态流 / 审批 Activity（`activity.yaml`）— shard-4，6 个

| ID | 用例 |
|---|---|
| ACT-01 | Activity overview shows live counters, banner and filter chips |
| ACT-02 | Incoming channel connection requests show pairing guidance |
| ACT-03 | Running filter isolates the in-flight execution with cancel |
| ACT-04 | Rejecting an action approval updates the feed and banner |
| ACT-05 | Accepted webhook deliveries can be inspected as payload JSON |
| ACT-06 | Error filter lists the three failed executions |

### 8. 文件与记忆 Files（`files.yaml`）— shard-4，8 个

| ID | 用例 |
|---|---|
| FILE-01 | Projects tree shows the fixture folders and files |
| FILE-02 | Opening a file renders its contents in the viewer |
| FILE-03 | Editing a text file persists within the session |
| FILE-04 | Creating a new file appears in the tree |
| FILE-05 | Renaming onto an existing name shows the conflict error |
| FILE-06 | Memory browser shows journal, relationship and project notes |
| FILE-07 | Today's journal entry exists under the dated journal path |
| FILE-08 | Memory notes can be edited and survive switching files |

### 9. 人脉 People（`people.yaml`）— shard-4，6 个

| ID | 用例 |
|---|---|
| PPL-01 | Latest feed shows recent conversations with previews |
| PPL-02 | Directory groups people by bond level with counts |
| PPL-03 | Bond filter chips narrow the directory |
| PPL-04 | Person detail renders the message timeline and composer |
| PPL-05 | Timeline channel filter keeps only WhatsApp messages |
| PPL-06 | Person actions menu offers bond, linking and merge management |

### 10. 设置 Settings（`settings.yaml`）— shard-5，11 个

| ID | 用例 |
|---|---|
| SET-01 | Settings redirect to Appearance and expose all six tabs |
| SET-02 | Appearance mode switches to Dark instantly |
| SET-03 | Connections list shows the nine fixture connections |
| SET-04 | Disconnecting a connection grant updates the card until refresh |
| SET-05 | App keys add flow validates input and saves successfully |
| SET-06 | Channels page lists conversation activation cards |
| SET-07 | AI Tools shows Claude connected with usage and supports logout |
| SET-08 | Favors page renders balance, pending decision and ledger |
| SET-09 | Advanced page exposes access control, computer use and developer toggles |
| SET-10 | Adding an allowed dashboard email saves and toasts |
| SET-11 | Developer toggles save via PUT /api/settings and persist across navigation |

### 11. 登录鉴权 Auth（`auth-shell.yaml`）— shard-5，3 个

| ID | 用例 |
|---|---|
| AUTH-01 | Mock guardian opens the app root and lands on the chat home |
| AUTH-02 | Login preview renders the local sign-in form with validation |
| AUTH-03 | Submitting the login form against the mock shows a login failure |

### 12. 外壳与全局 Shell / Global（`shell-global.yaml`）— shard-5/6，9 个

| ID | 分片 | 用例 |
|---|---|---|
| SHELL-01 | shard-5 | Sidebar entries navigate between every built-in page |
| SHELL-02 | shard-6 | Cmd+K opens chat search and finds a conversation |
| SHELL-03 | shard-6 | Cmd+B collapses and expands the sidebar |
| SHELL-04 | shard-5 | Edit mode removes a pinned entry and Add restores it |
| SHELL-05 | shard-6 | Mobile viewport opens the sidebar as a closable drawer（移动端视口） |
| SHELL-06 | shard-5 | Account menu shows identity and account actions |
| SHELL-07 | shard-6 | Log out is unsupported in mock mode and reports an error toast |
| GLOBAL-01 | shard-6 | Unknown routes redirect to the chat home |
| GLOBAL-02 | shard-6 | Switching the language to Chinese localizes the whole shell（中文本地化） |

### 13. 端到端跨页故事 E2E Stories（`e2e-*.yaml`）— 3 个

| ID | 分片 | 用例 / 故事线 |
|---|---|---|
| E2E-01 | shard-3 | **Turn on a routine proposed in chat and verify it lands in Routines**：在聊天卡片中开启「每周停滞检查」例行任务 → 返回 Routines 页确认已启用、计数增加 → 回到会话确认卡片状态不再重复创建。 |
| E2E-02 | shard-3 | **Approve the send_message card in chat and verify the Activity feed**：审批通过待发的 Telegram 消息卡片 → 动态流待审批计数从 3 降到 2 → Approved 筛选下可查看该执行及其 payload JSON。 |
| E2E-03 | shard-2 | **Open the built Issue Triage app from its chat link and find it in Apps**：从「一句话建应用」长会话中点击设计卡片、再点建成应用的链接 → Issue Triage 在工作区侧砖中打开 → Apps 页确认其已安装。 |

---

## 三、覆盖与不覆盖

**已覆盖**

- 全部主导航页面的首屏渲染与关键交互；
- 表单校验、成功/失败 toast、确认对话框、下拉菜单、开关、筛选/搜索/分页；
- 跨页/跨导航的内存态持久化（例行任务、审批、开发者开关）；
- 键盘快捷键（Cmd+K、Cmd+B）、移动端抽屉视口、深色模式、中英文本地化；
- 聊天内特殊卡片（审批、设计问答、应用内嵌链接、trace 展开）。

**mock 模式暂不覆盖（规划文档已记录缺口）**

- 对话 turn SSE 流式回复、sessions 用量指标、projects dashboard；
- 应用 fork / share、渠道侧 approve；
- 登出等依赖真实后端写操作的成功路径（仅验证其错误态）。

---

## 四、如何运行

```bash
cd tests/midscene
eval "$(fnm env)" && fnm use 24
# 需先在 localhost:3200 启动 mock server
MIDSCENE_RETRY=0 HEADLESS=true npm test                      # 全量
MIDSCENE_INCLUDE_TAGS=shard-5 HEADLESS=true npm test         # 跑单个分片
```

- 模型凭据通过未入库的 `tests/midscene/.env` 注入，CI 走 secrets。
- 单轮 HTML 汇总报告输出在 `tests/midscene/midscene_run/report/test-run-*.html`。
