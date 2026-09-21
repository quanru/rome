# Rome · Midscene E2E Case Overview

> Evaluation target: [Rome](https://github.com/rome-os/rome)
> Cases live in: `tests/midscene/cases/`
> Run mode: local **MSW mock mode** (synthetic fixtures, no real backend / credentials)
> Latest result: **91 / 91 passing with MIDSCENE_RETRY=0 (retries disabled; all passed on the first run)**
> Last updated: 2026-09-21

---

## 1. Overall

- **91 cases** in total, organized in 13 YAML files grouped by product module.
- Each case is driven by a mix of **visual assertions (aiAssert / aiTap)** and
  **deterministic nodes (custom `app.*` nodes)**, covering page rendering,
  interaction flows, form validation, toasts, cross-page persistence and
  responsive behavior.
- CI runs 6 shards in parallel; the shard is tagged directly on each case:

| Shard | Cases | Main contents |
|---|---|---|
| shard-1 | 14 | Chat core (composer, traces, feedback, copy) |
| shard-2 | 15 | App management 7, chat cards 7, end-to-end story 1 |
| shard-3 | 14 | Sessions 7, routines 5, end-to-end stories 2 |
| shard-4 | 20 | Activity 6, files/memory 8, people 6 |
| shard-5 | 17 | Settings 11, auth 3, shell navigation 3 |
| shard-6 | 11 | Recorded apps 5, shell/global 6 |
| **Total** | **91** | |

---

## 2. Case List by Module

### 1. Chat Core (`chat-core.yaml`) — shard-1, 14 cases

| ID | Case |
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

### 2. Chat Blocks (`chat-blocks.yaml`) — shard-2, 7 cases

| ID | Case |
|---|---|
| CHAT-15 | Answered design question card is locked with chosen answers |
| CHAT-16 | Built-app reply renders sections and a collapsible mermaid diagram |
| CHAT-17 | Learning kit links open YouTube Distill in a workspace tile |
| CHAT-18 | Workout plan links open Fitness Tracker in a workspace tile |
| CHAT-19 | Market recap links open a specific Stock Daily report tile |
| CHAT-20 | Live question card enables Send only after required answers |
| CHAT-21 | Rejecting the plumber approval resolves the card as rejected |

### 3. Apps (`apps.yaml`) — shard-2, 7 cases

| ID | Case |
|---|---|
| APPS-01 | Installed apps grid lists the five fixture apps and built-in entries |
| APPS-02 | Search narrows the apps grid |
| APPS-03 | Search without matches shows the empty state |
| APPS-04 | Disable an app from its tile menu and re-enable it |
| APPS-05 | Uninstall an app through the confirmation dialog |
| APPS-06 | App details page renders manage rows and capability cards |
| APPS-07 | Installing an unknown store handle shows the not-found state |

### 4. Recorded Apps (`recorded-apps.yaml`) — shard-6, 5 cases

> These apps render inside open Shadow DOM and are the product's built-in
> record-and-replay demo applications.

| ID | Case |
|---|---|
| RAPP-01 | Issue Triage dashboard shows repository and recent triage results |
| RAPP-02 | YouTube Distill opens the recorded talk with its mind map |
| RAPP-03 | Code Review dashboard opens the recorded PR review with verdict |
| RAPP-04 | Fitness Tracker shows the weekly plan and beginner settings |
| RAPP-05 | Stock Daily shows the weekday schedule and a full report |

### 5. Sessions (`sessions.yaml`) — shard-3, 7 cases

| ID | Case |
|---|---|
| SES-01 | Sessions list renders the fixture rows with columns and pagination |
| SES-02 | Search filters sessions across title and context |
| SES-03 | Facet filter restricts to Channel sessions and shows a filter chip |
| SES-04 | Time range selector widens the list to all-time sessions |
| SES-05 | Empty result state for an unmatched search |
| SES-06 | Channel session detail shows read-only header and Details sheet |
| SES-07 | Webchat session detail offers Open chat back to the conversation |

### 6. Routines (`routines.yaml`) — shard-3, 5 cases

| ID | Case |
|---|---|
| ROUT-01 | Routines list shows totals, groups, schedules and switches |
| ROUT-02 | Calendar view renders the month with run markers |
| ROUT-03 | Timeline view orders upcoming schedule runs on a time axis |
| ROUT-04 | Create Routine dialog explains the three trigger types |
| ROUT-05 | Toggling the on-demand routine updates the active count |

### 7. Activity / Approvals (`activity.yaml`) — shard-4, 6 cases

| ID | Case |
|---|---|
| ACT-01 | Activity overview shows live counters, banner and filter chips |
| ACT-02 | Incoming channel connection requests show pairing guidance |
| ACT-03 | Running filter isolates the in-flight execution with cancel |
| ACT-04 | Rejecting an action approval updates the feed and banner |
| ACT-05 | Accepted webhook deliveries can be inspected as payload JSON |
| ACT-06 | Error filter lists the three failed executions |

### 8. Files and Memory (`files.yaml`) — shard-4, 8 cases

| ID | Case |
|---|---|
| FILE-01 | Projects tree shows the fixture folders and files |
| FILE-02 | Opening a file renders its contents in the viewer |
| FILE-03 | Editing a text file persists within the session |
| FILE-04 | Creating a new file appears in the tree |
| FILE-05 | Renaming onto an existing name shows the conflict error |
| FILE-06 | Memory browser shows journal, relationship and project notes |
| FILE-07 | Today's journal entry exists under the dated journal path |
| FILE-08 | Memory notes can be edited and survive switching files |

### 9. People (`people.yaml`) — shard-4, 6 cases

| ID | Case |
|---|---|
| PPL-01 | Latest feed shows recent conversations with previews |
| PPL-02 | Directory groups people by bond level with counts |
| PPL-03 | Bond filter chips narrow the directory |
| PPL-04 | Person detail renders the message timeline and composer |
| PPL-05 | Timeline channel filter keeps only WhatsApp messages |
| PPL-06 | Person actions menu offers bond, linking and merge management |

### 10. Settings (`settings.yaml`) — shard-5, 11 cases

| ID | Case |
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

### 11. Auth (`auth-shell.yaml`) — shard-5, 3 cases

| ID | Case |
|---|---|
| AUTH-01 | Mock guardian opens the app root and lands on the chat home |
| AUTH-02 | Login preview renders the local sign-in form with validation |
| AUTH-03 | Submitting the login form against the mock shows a login failure |

### 12. Shell / Global (`shell-global.yaml`) — shard-5/6, 9 cases

| ID | Shard | Case |
|---|---|---|
| SHELL-01 | shard-5 | Sidebar entries navigate between every built-in page |
| SHELL-02 | shard-6 | Cmd+K opens chat search and finds a conversation |
| SHELL-03 | shard-6 | Cmd+B collapses and expands the sidebar |
| SHELL-04 | shard-5 | Edit mode removes a pinned entry and Add restores it |
| SHELL-05 | shard-6 | Mobile viewport opens the sidebar as a closable drawer |
| SHELL-06 | shard-5 | Account menu shows identity and account actions |
| SHELL-07 | shard-6 | Log out is unsupported in mock mode and reports an error toast |
| GLOBAL-01 | shard-6 | Unknown routes redirect to the chat home |
| GLOBAL-02 | shard-6 | Switching the language to Chinese localizes the whole shell |

### 13. End-to-End Cross-Page Stories (`e2e-*.yaml`) — 3 cases

| ID | Shard | Case / Storyline |
|---|---|---|
| E2E-01 | shard-3 | **Turn on a routine proposed in chat and verify it lands in Routines**: enable the "weekly stagnation check" routine from its chat card → go back to the Routines page and confirm it is enabled with the count incremented → return to the conversation and confirm the card state does not offer duplicate creation. |
| E2E-02 | shard-3 | **Approve the send_message card in chat and verify the Activity feed**: approve the pending Telegram message card → the pending-approval count in Activity drops from 3 to 2 → the execution and its payload JSON are visible under the Approved filter. |
| E2E-03 | shard-2 | **Open the built Issue Triage app from its chat link and find it in Apps**: from the long "build an app from one sentence" conversation, click the design card and then the built-app link → Issue Triage opens in a workspace tile → the Apps page confirms it is installed. |

---

## 3. Coverage

**Covered**

- First-screen rendering and key interactions of every primary navigation page;
- Form validation, success/failure toasts, confirmation dialogs, dropdown menus,
  toggles, filter/search/pagination;
- Cross-page/cross-navigation in-memory persistence (routines, approvals,
  developer toggles);
- Keyboard shortcuts (Cmd+K, Cmd+B), the mobile drawer viewport, dark mode and
  English/Chinese localization;
- Special in-chat cards (approvals, design Q&A, embedded app links, expanded
  traces).

**Not covered in mock mode yet (gaps recorded in the planning doc)**

- Conversation turn SSE streaming replies, sessions usage metrics, projects
  dashboard;
- App fork / share, channel-side approve;
- Success paths of writes that depend on a real backend (such as logout) — only
  their error states are verified.

---

## 4. How to Run

```bash
cd tests/midscene
eval "$(fnm env)" && fnm use 24
# The mock server must already be running on localhost:3200
MIDSCENE_RETRY=0 HEADLESS=true npm test                      # full suite
MIDSCENE_INCLUDE_TAGS=shard-5 HEADLESS=true npm test         # one shard
```

- Model credentials are injected via the untracked `tests/midscene/.env`
  locally and via secrets in CI.
- The per-run aggregated HTML report is written to
  `tests/midscene/midscene_run/report/test-run-*.html`.
