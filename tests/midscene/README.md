# Rome × Midscene Visual E2E

Visual-driven end-to-end testing for Rome using
[Midscene](https://midscenejs.com/) YAML cases. Tests run against Rome's
**MSW mock mode** (`pnpm dev:mock`): they never hit a real backend or use real
personal data, and every assertion is backed by in-repo synthetic fixtures, so
the cases are fully deterministic, reproducible offline, and runnable on fork
PRs.

> The companion planning doc is
> [`docs/midscene-e2e-plan.md`](../../docs/midscene-e2e-plan.md) (case catalog,
> mock contract, CI shard design).

## How It Works

- `midscene.config.ts` launches Playwright Chromium with a **fresh
  BrowserContext per case**: in-memory MSW state resets with the context, so
  every case starts from the same fixtures.
- An init script seeds two localStorage contracts only when the app has no
  stored value yet (it does not overwrite a case's own choice, so a language
  switch or sidebar edit persists across navigation):
  - `rome.lang = en`: pins the English UI (avoids locale interference on a
    Chinese CI machine);
  - `rome-sidebar-pins`: expands every built-in sidebar entry (the mock user
    pins only Apps/Chat/Projects by default).
- Alongside Midscene's built-in AI nodes (`aiTap`/`aiAssert`/`aiAct`/`wait`,
  etc.), this package registers 15 deterministic nodes:
  `app.open`, `app.reload`, `app.goBack`, `app.expectUrl`,
  `app.clickContentLink`, `app.clickByLabel`, `app.expectControl`,
  `app.expectMenuItem`, `app.expectTexts`, `app.expectDom`, `app.monacoEdit`,
  `app.scrollContent`, `app.scrollTextIntoView`, `app.pressKey`, and
  `app.typeText` (see `midscene-node-reference.md` for the full node list and
  their parameters).
- All cases live in `cases/**/*.yaml`, organized by suite file, with tags for
  shard and topic.

## Prerequisites

- Node.js 24 (the repo pins it via fnm: `eval "$(fnm env)" && fnm use 24`)
- Rome dependencies installed (`pnpm install` at the repo root)
- Credentials for the visual model Midscene uses (an OpenAI-compatible API)

## Running Locally

```bash
# 1. Start Rome mock mode (at the repo root or in packages/web)
pnpm dev:mock
# Served at http://localhost:3200; logs default to /tmp/rome-devmock.log

# 2. Install test dependencies (first time only)
cd tests/midscene
npm install
npx playwright install chromium

# 3. Configure model credentials (first time only; .env is gitignored — never commit it)
cp .env.example .env
# Edit .env and fill in MIDSCENE_MODEL_BASE_URL / API_KEY / NAME / FAMILY

# 4. Run the full suite
npm test
```

### Selecting Cases

Tag filtering is controlled through environment variables (read in
`midscene.config.ts`):

```bash
# PoC stories only
MIDSCENE_INCLUDE_TAGS=poc npm test

# One suite (a case can carry multiple tags)
MIDSCENE_INCLUDE_TAGS=routines npm test

# Multiple tags are OR-combined, comma-separated
MIDSCENE_INCLUDE_TAGS=auth,settings npm test

# Exclude slow cases
MIDSCENE_EXCLUDE_TAGS=story npm test

# Adjust retries (default 2; CI sets it per shard as needed)
MIDSCENE_RETRY=0 npm test

# Headed mode for debugging
HEADLESS=false npm test
```

### Tag Conventions

| Tag | Meaning |
| --- | --- |
| `poc` | Accepted PoC storylines (AUTH-01, E2E-01/02/03) |
| `story` | Cross-page end-to-end storylines (slower) |
| `auth` / `chat` / `apps` / `sessions` / `routines` / `activity` / `people` / `files` / `settings` / `shell` / `global` | Functional suites |
| `shard-N` | CI shard ownership (N=1…6), see the planning doc |
| `zh` | Chinese-UI (i18n) cases |
| `mobile` | Narrow-viewport cases |

## Reports and Artifacts

- HTML reports: `midscene_run/report/`
- Machine-readable results:
  `.midscene/test-results/<runId>/summary.json` (includes collection-error
  details)
- Both are covered by `.gitignore`.

## Authoring Conventions

1. **Every case starts with `app.open`** to guarantee fixture reset; use
   `app.reload` only when verifying "after refresh" behavior.
2. Prefer deterministic nodes for navigation/scrolling/URL assertions; reserve
   `aiTap`/`aiAssert` for visual-semantic judgments.
3. `aiAssert` copy quotes the actual English UI text and describes structure
   explicitly (presence/absence of cards, badges, buttons).
4. Parameter-less custom nodes must be written as `app.goBack: {}` in YAML;
   otherwise they parse as scalars and collection fails.
5. Cases assert only against synthetic fixture data in the repo; never
   introduce real names, accounts or credentials.
6. Chat pages stick to the bottom: programmatic scrolling is pushed back, so
   for long transcripts use `app.scrollTextIntoView` (internally it first sends
   a trusted wheel gesture to release the stick-to-bottom behavior).
7. The file-browser editor (Projects/Memory) is Monaco, where visual actions
   are very slow and unstable: switch to the Edit view first, then use
   `app.monacoEdit` (changes the value through the monaco API; `save: true`
   waits for the PUT to finish). Assert disabled button state with
   `app.expectControl` instead of trying to tell it apart from a screenshot.
8. For repeated same-name controls (the sessions question card and the composer
   each have a "Send"), select by DOM order with
   `app.clickByLabel: { index: n }`. The selected check in dropdown menus such
   as the composer's "Reasoning effort" has no `aria-checked`; assert it with
   `app.expectMenuItem` instead of having the model count checkmarks in a
   screenshot. `app.clickByLabel` also covers both `<a>` (settings
   sub-navigation) and `<summary>` (disclosure regions like Developer
   Settings), so use it — not `aiTap` — for cross-settings navigation and
   expanding disclosures.
9. For cards/messages taller than one viewport (the five-question design card,
   multi-section build replies, the nine-item Connections list, the Channels
   conversation list), a screenshot shows only part of them: use
   `app.expectTexts: { all: [...] }` to verify the full-text manifest via the
   DOM, and let the visual assertion describe only what is visible in the
   current viewport after scroll positioning.
10. "Locked" states such as an answered question card are almost
    indistinguishable from editable state in a screenshot (a disabled fieldset
    still renders placeholder copy): assert structural facts with
    `app.expectDom` — `fieldset[disabled]`, the count of
    `button[aria-pressed="true"]`, the number of buttons in the bottom action
    row, and so on.
11. Steps that are **expected to trip form validation** must not use a single
    `aiAct` (the model treats "submission was rejected" as its own task failure
    and retries until the replan budget is exhausted): split into
    `app.typeText` (located by placeholder or `<label for>`) + `app.clickByLabel`
    to submit + `app.expectTexts` to assert the validation copy; resubmitting
    after correcting the input works the same way.
12. Toasts render in a sonner portal outside `<main>` and disappear after a few
    seconds: use `app.expectTexts: { scope: body }` to poll the toast copy
    immediately after the triggering action, not `aiAssert` (the toast is often
    already gone by screenshot time); persistent list/form changes go through
    the default `scope: main` DOM assertions.
13. Product static assets missing in mock mode (such as
    `/desktop-vnc.html` embedded in the desktop workspace, served by @rome/core
    in production) get placeholder files under `packages/web/mock/public/`;
    MSW (a browser Service Worker) cannot intercept an iframe's initial
    document navigation (the new frame has not registered the worker yet), so
    these requests must go through the dev server's static layer.
14. Recorded apps (`/apps/*-*`, e.g. issue-triage, yt-distill) render inside an
    **open Shadow DOM**: visual assertions (`aiAssert`/`aiTap`) and Playwright's
    role engine work normally, but the `innerText`/`main` selectors behind
    `app.expectTexts`/`app.expectDom` cannot pierce the shadow root — do not
    use those two nodes on these pages.
