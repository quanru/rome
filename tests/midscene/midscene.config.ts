import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineNode, z } from "@midscene/test";
import type { NodeExecutionContext } from "@midscene/test";
import { defineProjectSetup, defineTestProject } from "@midscene/test/config";
import { createMidsceneNodes } from "@midscene/test/midscene";
import { PlaywrightAgent } from "@midscene/web/playwright/agent";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

loadEnv({ path: fileURLToPath(new URL(".env", import.meta.url)) });

const BASE_URL = process.env.ROME_E2E_BASE_URL ?? "http://localhost:3200";
const BASE_ORIGIN = new URL(BASE_URL).origin;
// The mock app boots with an English UI when no language is cached, but Chinese
// CI runners would detect zh-CN from the OS. Pin English explicitly so every
// assertion in the YAML cases targets one language.
const LOCALE = "en";

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

interface ProjectContext {
  browser: Browser;
  browserContext?: BrowserContext;
  page?: Page;
  agent?: PlaywrightAgent;
}

const getAgent = ({ context }: NodeExecutionContext<unknown, ProjectContext>) => {
  if (!context.page) throw new Error("No page is open; call app.open before AI steps");
  context.agent ??= new PlaywrightAgent(context.page);
  return context.agent;
};

const setup = defineProjectSetup<ProjectContext>({
  name: "web",
  async setup({ env, onTeardown }) {
    const browser = await chromium.launch({ headless: env.HEADLESS !== "false" });
    const context: ProjectContext = { browser };
    onTeardown(async () => {
      await context.agent?.destroy();
      await context.browserContext?.close().catch(() => undefined);
      await browser.close();
    });
    return context;
  },
});

// The mock user starts with only Apps/Chat/Projects pinned. Product stories
// cross between pages through the sidebar, so pin every built-in destination
// up front (rome-sidebar-pins, the shell's own localStorage contract). This
// also avoids the "all apps" popover and keeps clicks deterministic.
const DEFAULT_PINS = [
  "apps",
  "projects",
  "sessions",
  "memory",
  "people",
  "routines",
  "activity",
  "desktop",
  "chat",
  "settings",
] as const;

const openInput = z.strictObject({
  path: z.string().min(1),
  // 'shell' waits for the authenticated sidebar (mock guardian), 'login' for
  // the login route, and 'any' only waits for the document to load.
  waitUntil: z.enum(["shell", "login", "any"]).default("shell"),
  // Extra built-in nav ids to pin in addition to the default set.
  pins: z.array(z.string()).optional(),
  // 'mobile' opens a phone-sized viewport (sidebar becomes a drawer).
  viewport: z.enum(["desktop", "mobile"]).default("desktop"),
});

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const;

const appOpen = defineNode<typeof openInput, void, ProjectContext>({
  name: "app.open",
  description:
    "Open a Rome route in a fresh browser context. A fresh context also resets " +
    "the in-memory MSW mock state, so every case starts from the same fixtures.",
  inputSchema: openInput,
  async execute({ context, input }) {
    // Tear down the previous case's page/agent before creating the new context.
    await context.agent?.destroy().catch(() => undefined);
    context.agent = undefined;
    await context.browserContext?.close().catch(() => undefined);

    const browserContext = await context.browser.newContext({
      viewport: VIEWPORTS[input.viewport],
      locale: "en-US",
      // Fixtures encode absolute instants (e.g. Stock Daily's
      // 2026-09-15T20:30:00Z, asserted as "09/16, 04:30 AM"). GitHub's hosted
      // runners run in UTC and a developer's laptop may run in any zone, so a
      // host-dependent zone would reformat those timestamps differently. Pin
      // the zone in which every case is authored; the wall clock is left real
      // because mock timestamps are generated as offsets from now (freezing
      // Date in the page would mislabel the Today/Yesterday grouping).
      timezoneId: "Asia/Shanghai",
      // The copy-message control only swaps to its "Copied" confirmation once
      // navigator.clipboard.writeText resolves; grant it explicitly so the
      // feedback is deterministic under headless CI.
      permissions: ["clipboard-read", "clipboard-write"],
    });
    // The suite promises an offline/local mock boundary. Abort browser traffic
    // to every other origin so a recorded app cannot silently add a CDN or
    // third-party dependency. Model calls are made by the Node-side agent and
    // are therefore outside this browser request guard.
    await browserContext.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (new URL(requestUrl).origin === BASE_ORIGIN) {
        await route.continue();
        return;
      }
      await route.abort("blockedbyclient");
    });
    // Pin the i18n language and sidebar entries before the app bundle runs.
    const pins = [...DEFAULT_PINS, ...(input.pins ?? [])].map((id) => ({
      type: "builtin" as const,
      id,
    }));
    await browserContext.addInitScript(
      ({ lang, sidebarPins }) => {
        // Seed defaults only when the app has not stored a value: cases run
        // in a fresh context start in English with every built-in pinned,
        // but a case that switches the language (or edits pins) keeps its
        // choice across in-context navigations instead of being reset here.
        if (!window.localStorage.getItem("rome.lang")) {
          window.localStorage.setItem("rome.lang", lang);
        }
        if (!window.localStorage.getItem("rome-sidebar-pins")) {
          window.localStorage.setItem("rome-sidebar-pins", JSON.stringify(sidebarPins));
        }
      },
      { lang: LOCALE, sidebarPins: pins },
    );
    const page = await browserContext.newPage();
    context.browserContext = browserContext;
    context.page = page;

    const url = input.path.startsWith("http")
      ? input.path
      : `${BASE_URL}${input.path.startsWith("/") ? "" : "/"}${input.path}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });

    if (input.waitUntil === "shell") {
      // The authenticated sidebar only renders after MSW answers /api/health,
      // /api/bootstrap and /api/auth/me, so this doubles as the mock-ready wait.
      await page.locator('a[href="/chat"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
    } else if (input.waitUntil === "login") {
      await page.waitForURL(/\/login/, { timeout: 60_000 });
      // The URL matches immediately after domcontentloaded; wait until the
      // LoginPage bundle has actually mounted the form.
      await page.locator('input[type="password"]').first().waitFor({
        state: "visible",
        timeout: 60_000,
      });
    }
  },
});

const scrollInput = z.strictObject({
  position: z.enum(["top", "bottom"]),
});

const appScrollContent = defineNode<typeof scrollInput, void, ProjectContext>({
  name: "app.scrollContent",
  description:
    "Scroll the main content scroll container (right of the sidebar) to its " +
    "top or bottom, deterministically.",
  inputSchema: scrollInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    // Kept as a *string* expression and evaluated via page.evaluate(string):
    // esbuild rewrites nested function declarations inside evaluate callbacks
    // with __name() helpers that do not exist in the browser runtime. The walk
    // descends into open shadow roots (recorded apps render inside one) and
    // also considers the document scrolling element (pages like Sessions that
    // scroll the window itself). It pins the tallest scroller twice because
    // the transcript snaps itself back to the newest content while replaying.
    const scrollExpr =
      "(() => {" +
      "  const scrollables = [];" +
      "  const doc = document.scrollingElement;" +
      "  if (doc && doc.scrollHeight > window.innerHeight + 50) scrollables.push(doc);" +
      "  const stack = [document];" +
      "  while (stack.length) {" +
      "    const root = stack.pop();" +
      '    root.querySelectorAll("*").forEach((el) => {' +
      "      if (el.shadowRoot) stack.push(el.shadowRoot);" +
      "      const o = getComputedStyle(el).overflowY;" +
      '      if ((o === "auto" || o === "scroll" || o === "overlay") &&' +
      "          el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 50) {" +
      "        scrollables.push(el);" +
      "      }" +
      "    });" +
      "  }" +
      '  if (!scrollables.length) throw new Error("No scrollable content container found");' +
      "  const target = scrollables.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];" +
      `  target.scrollTop = ${input.position === "top" ? "0" : "target.scrollHeight"};` +
      "})()";
    await page.evaluate(scrollExpr);
    await page.waitForTimeout(900);
    await page.evaluate(scrollExpr);
    await page.waitForTimeout(400);
  },
});

const scrollTextInput = z.strictObject({
  text: z.string().min(1),
});

const appScrollTextIntoView = defineNode<typeof scrollTextInput, void, ProjectContext>({
  name: "app.scrollTextIntoView",
  description:
    "Scroll the nearest scrollable ancestor so the element whose visible " +
    "text contains the given string is centered in the viewport. Unlike " +
    "scrolling to an absolute position, this survives late layout shifts " +
    "(e.g. mermaid diagrams re-rendering).",
  inputSchema: scrollTextInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    // The chat's stick-to-bottom hook ignores programmatic scrolls and snaps
    // back on every content resize (streamed blocks, mermaid). Only a trusted
    // wheel gesture releases the pin, so emulate one over the transcript
    // before positioning.
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, -4000);
    await page.waitForTimeout(350);
    // getByText pierces open shadow roots, so this also positions content
    // inside recorded apps.
    const target = page.getByText(input.text, { exact: false }).last();
    await target.waitFor({ state: "visible", timeout: 30_000 });
    await target.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(500);
  },
});

const contentLinkInput = z.strictObject({
  text: z.string().min(1),
});

// The same app name appears as both a sidebar entry and a link inside chat
// markdown (e.g. "Issue Triage"), so a vision-based tap is ambiguous. The
// conversation content always sits right of the 255px sidebar.
const appClickContentLink = defineNode<typeof contentLinkInput, void, ProjectContext>({
  name: "app.clickContentLink",
  description:
    "Click a hyperlink by its visible text inside the main content area " +
    "(excludes the left sidebar), deterministically via Playwright.",
  inputSchema: contentLinkInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const candidates = await page.locator("a:visible").filter({ hasText: input.text }).all();
    for (const anchor of candidates) {
      const box = await anchor.boundingBox();
      if (box && box.x >= 255) {
        await anchor.scrollIntoViewIfNeeded();
        await anchor.click({ timeout: 15_000 });
        return;
      }
    }
    throw new Error(`No content-area link containing "${input.text}"`);
  },
});

const clickByLabelInput = z.strictObject({
  // Substring of the control's accessible name (aria-label / aria-labelledby
  // / inner text). The role engine matches across open shadow roots.
  label: z.string().min(1),
  // Match the accessible name exactly instead of as a substring. Needed for
  // short labels like "Running" that otherwise match "Running 1" counters.
  exact: z.boolean().default(false),
  // When several visible controls share the name (e.g. a question card's
  // "Send" above the composer's "Send"), which one to click in DOM order
  // (0-based). Defaults to the first.
  index: z.number().int().min(0).default(0),
});

const appClickByLabel = defineNode<typeof clickByLabelInput, void, ProjectContext>({
  name: "app.clickByLabel",
  description:
    "Click an icon-only or ambiguously placed control by its accessible name " +
    "(aria-label or inner text), deterministically. Use this instead of aiTap " +
    "for tile kebab menus, repeated icon buttons, and short-text filter chips " +
    "where a visual tap could hit the wrong element. Also matches settings " +
    "sub-navigation <a> links (e.g. jump from Advanced back to Connections) " +
    'and plain <summary> disclosure headings such as "Developer Settings". ' +
    "Works inside open shadow roots. Set exact:true when the label is short " +
    '(e.g. "Running" must not match a "Running 1" counter), and index to ' +
    'disambiguate repeated names such as a composer "Send" that shares the ' +
    'page with a question-card "Send".',
  inputSchema: clickByLabelInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const escaped = input.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = input.exact ? new RegExp(`^${escaped}$`, "i") : new RegExp(escaped, "i");
    const lists = [
      page.getByRole("button", { name: pattern, exact: input.exact }),
      // Settings sub-navigation renders <a href="/settings/..."> entries
      // (e.g. jumping from Advanced back to Connections).
      page.getByRole("link", { name: pattern, exact: input.exact }),
      // Segmented controls render <button role="radio"> (timeline channel
      // filters), whose accessible role is "radio", not "button".
      page.getByRole("radio", { name: pattern, exact: input.exact }),
      // Collapsible disclosures like "Developer Settings" are plain
      // <summary> elements with no role/aria-label.
      page.locator("summary", { hasText: pattern }),
      page.locator(`[aria-label*="${input.label}" i]`),
    ];
    for (const list of lists) {
      const count = await list.count();
      if (count <= input.index) continue;
      const target = list.nth(input.index);
      if (await target.isVisible().catch(() => false)) {
        await target.click({ timeout: 15_000 });
        await page.waitForTimeout(300);
        return;
      }
    }
    throw new Error(
      `app.clickByLabel: no visible control labelled "${input.label}" at index ${input.index}`,
    );
  },
});

const goBackInput = z.strictObject({});

const expectControlInput = z.strictObject({
  // Accessible name of the button to inspect (aria-label / inner text).
  label: z.string().min(1),
  // Exact accessible-name match; defaults to true.
  exact: z.boolean().default(true),
  // Require the control enabled (false) or disabled (true). Disabled state is
  // a DOM property that is easy to misread from a screenshot (a disabled
  // accent button can still look pink), so assert it deterministically.
  disabled: z.boolean().optional(),
  // For <button role="radio"> segmented controls, require aria-checked
  // true/false. The checked fill is subtle and easy to misread visually
  // (neighbouring radios can look equally dark in a screenshot).
  checked: z.boolean().optional(),
  // Accessible role to match; segmented controls use "radio" and routine
  // toggle switches use "switch". Defaults to "button".
  role: z.enum(["button", "radio", "switch"]).default("button"),
  // Require the control to be present and visible (default) or absent.
  present: z.boolean().default(true),
  // When several controls share the name, which match to inspect in DOM order
  // (0-based). Defaults to the first.
  index: z.number().int().min(0).default(0),
});

const appExpectControl = defineNode<typeof expectControlInput, void, ProjectContext>({
  name: "app.expectControl",
  description:
    "Assert a button or radio-segment control state deterministically via " +
    "Playwright instead of a screenshot: whether it exists/is visible, " +
    'whether it is disabled, and (for role:"radio") whether it is checked. ' +
    "Use for disabled-vs-enabled distinctions that look identical in a " +
    "screenshot (e.g. a question card Send button), for transient aria-label " +
    'swaps such as "Copied" or "Feedback recorded", and for segmented-control ' +
    "selection whose checked fill is visually ambiguous.",
  inputSchema: expectControlInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const escaped = input.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const name = input.exact ? new RegExp(`^${escaped}$`, "i") : new RegExp(escaped, "i");
    const matched = page.getByRole(input.role, { name, exact: input.exact });
    const count = await matched.count();
    if (!input.present) {
      for (let i = 0; i < count; i += 1) {
        if (
          await matched
            .nth(i)
            .isVisible()
            .catch(() => false)
        ) {
          throw new Error(
            `app.expectControl: a visible "${input.label}" ${input.role} still exists`,
          );
        }
      }
      return;
    }
    if (count <= input.index) {
      throw new Error(
        `app.expectControl: found ${count} ${input.role}(s) labelled "${input.label}", need index ${input.index}`,
      );
    }
    const target = matched.nth(input.index);
    await target.waitFor({ state: "visible", timeout: 10_000 });
    if (input.disabled !== undefined) {
      const isDisabled = await target.isDisabled();
      if (isDisabled !== input.disabled) {
        throw new Error(
          `app.expectControl: "${input.label}" expected ${input.disabled ? "disabled" : "enabled"}, ` +
            `got ${isDisabled ? "disabled" : "enabled"}`,
        );
      }
    }
    if (input.checked !== undefined) {
      const isChecked = (await target.getAttribute("aria-checked")) === "true";
      if (isChecked !== input.checked) {
        throw new Error(
          `app.expectControl: "${input.label}" expected ${input.checked ? "checked" : "unchecked"}, ` +
            `got ${isChecked ? "checked" : "unchecked"}`,
        );
      }
    }
  },
});

const expectTextsInput = z.strictObject({
  // Every string must appear in the scoped element's visible text (case
  // insensitive). Use for long cards/transcripts whose full contents extend
  // beyond one screenshot, so a vision assertion can only see part of them.
  all: z.array(z.string().min(1)).default([]),
  // None of the strings may appear.
  none: z.array(z.string().min(1)).default([]),
  // Each entry is a case-insensitive regular expression that must match the
  // visible text — use for date-dependent text that must not pin a month,
  // e.g. a calendar heading /(January|…|December) 20\\d\\d/.
  matches: z.array(z.string().min(1)).default([]),
  // Where to read text: the <main> content (default) or the whole document
  // body. "body" is required for toasts, which sonner renders in a portal
  // outside <main> and auto-dismisses after a few seconds.
  scope: z.enum(["main", "body"]).default("main"),
});

const appExpectTexts = defineNode<typeof expectTextsInput, void, ProjectContext>({
  name: "app.expectTexts",
  description:
    "Assert that text contains (or does not contain) the given strings, " +
    "deterministically via the DOM instead of a screenshot. Use for long " +
    "cards or transcripts whose complete contents are taller than one " +
    "viewport — e.g. a five-question card where a screenshot shows only the " +
    'first two questions and its "Answered" footer. Set scope:"body" to ' +
    "catch toasts, which render in a portal outside <main>. Vision aiAssert " +
    'is for how things look; this node is for "all of these words exist ' +
    'somewhere on the page". Use "matches" for regex patterns (e.g. ' +
    "date-dependent headings that must stay independent of the run month).",
  inputSchema: expectTextsInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const root = input.scope === "body" ? page.locator("body") : page.locator("main").first();
    const patterns = input.matches.map((source) => new RegExp(source, "i"));
    // The transcript renders after the messages fetch resolves (and toasts
    // appear briefly after an action); poll for the text instead of requiring
    // it to be present on the first read.
    const deadline = Date.now() + 10_000;
    let text = "";
    for (;;) {
      text = (await root.innerText().catch(() => "")).toLowerCase();
      const missing = input.all.filter((needle) => !text.includes(needle.toLowerCase()));
      const present = input.none.filter((needle) => text.includes(needle.toLowerCase()));
      const unmatched = patterns.filter((pattern) => !pattern.test(text)).map(String);
      if (
        (missing.length === 0 && present.length === 0 && unmatched.length === 0) ||
        Date.now() >= deadline
      ) {
        if (!text) throw new Error(`app.expectTexts: no ${input.scope} text found`);
        if (missing.length > 0) {
          throw new Error(`app.expectTexts: missing expected text: ${JSON.stringify(missing)}`);
        }
        if (present.length > 0) {
          throw new Error(
            `app.expectTexts: text expected absent was found: ${JSON.stringify(present)}`,
          );
        }
        if (unmatched.length > 0) {
          throw new Error(`app.expectTexts: text did not match: ${JSON.stringify(unmatched)}`);
        }
        return;
      }
      await page.waitForTimeout(500);
    }
  },
});

const expectDomInput = z.strictObject({
  // CSS selector scoped to the page's <main> region.
  selector: z.string().min(1),
  // Require exactly this many *visible* matches (e.g. count: 0 to assert a
  // control is gone).
  count: z.number().int().min(0).optional(),
  // Require at least this many visible matches.
  minCount: z.number().int().min(0).optional(),
  // Require every match to be disabled/enabled (form-field property).
  disabled: z.boolean().optional(),
  // Require every match to carry the attribute; when value is given it must
  // equal it (e.g. aria-pressed="true").
  attribute: z.strictObject({ name: z.string().min(1), value: z.string().optional() }).optional(),
});

const appExpectDom = defineNode<typeof expectDomInput, void, ProjectContext>({
  name: "app.expectDom",
  description:
    "Assert structural/state facts about the main content via a CSS selector " +
    "and the DOM, instead of a screenshot: how many visible elements match, " +
    "whether they are disabled, and whether they carry an attribute such as " +
    "aria-pressed. Use for state that is invisible or ambiguous in an image " +
    "(a <fieldset disabled> locking an answered card, pressed option " +
    "buttons, absence of a footer action).",
  inputSchema: expectDomInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const locator = page.locator(`main ${input.selector}`);
    const total = await locator.count();
    const visible: Locator[] = [];
    for (let i = 0; i < total; i += 1) {
      const el = locator.nth(i);
      if (await el.isVisible().catch(() => false)) visible.push(el);
    }
    const n = visible.length;
    if (input.count !== undefined && n !== input.count) {
      throw new Error(
        `app.expectDom: "${input.selector}" expected ${input.count} visible match(es), got ${n}`,
      );
    }
    if (input.minCount !== undefined && n < input.minCount) {
      throw new Error(
        `app.expectDom: "${input.selector}" expected at least ${input.minCount} visible match(es), got ${n}`,
      );
    }
    if (input.disabled !== undefined) {
      for (const el of visible) {
        const isDisabled = await el.isDisabled().catch(() => true);
        if (isDisabled !== input.disabled) {
          throw new Error(
            `app.expectDom: "${input.selector}" expected ${input.disabled ? "disabled" : "enabled"}`,
          );
        }
      }
    }
    if (input.attribute) {
      for (const el of visible) {
        const actual = await el.getAttribute(input.attribute.name).catch(() => null);
        if (
          actual === null ||
          (input.attribute.value !== undefined && actual !== input.attribute.value)
        ) {
          throw new Error(
            `app.expectDom: "${input.selector}" expected attribute ${input.attribute.name}` +
              (input.attribute.value !== undefined ? `="${input.attribute.value}"` : "") +
              `, got ${actual === null ? "absent" : `"${actual}"`}`,
          );
        }
      }
    }
  },
});

const expectMenuItemInput = z.strictObject({
  // Visible text of the dropdown menu item.
  label: z.string().min(1),
  // Exact text match; defaults to true.
  exact: z.boolean().default(true),
  // Require the item's selected/check indicator present (true) or absent
  // (false). Radix dropdowns mark the current choice with a lucide check
  // icon rather than aria-checked, and that small tick is easy to miss in a
  // screenshot, so assert it from the DOM.
  checked: z.boolean().optional(),
  // Require the item to be present and visible (default) or absent.
  present: z.boolean().default(true),
});

const appExpectMenuItem = defineNode<typeof expectMenuItemInput, void, ProjectContext>({
  name: "app.expectMenuItem",
  description:
    "Assert the state of an open dropdown-menu item deterministically via " +
    "Playwright: whether it is visible, and whether it carries the selected " +
    "check icon (the current choice). Use for option menus such as the " +
    'composer "Reasoning effort" picker, whose current value is marked only ' +
    "with a small check tick instead of aria-checked. Open the menu first " +
    "(e.g. app.clickByLabel).",
  inputSchema: expectMenuItemInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const items = await page.getByRole("menuitem").all();
    const visible: { text: string; handle: (typeof items)[number] }[] = [];
    for (const item of items) {
      if (!(await item.isVisible().catch(() => false))) continue;
      const text = (await item.innerText().catch(() => "")).trim();
      const matches = input.exact ? text === input.label : text.includes(input.label);
      if (matches) visible.push({ text, handle: item });
    }
    if (!input.present) {
      if (visible.length > 0) {
        throw new Error(`app.expectMenuItem: a visible "${input.label}" menu item still exists`);
      }
      return;
    }
    if (visible.length === 0) {
      const menuText = (await Promise.all(items.map((item) => item.innerText().catch(() => ""))))
        .map((t) => t.trim())
        .filter(Boolean)
        .join(" | ");
      throw new Error(
        `app.expectMenuItem: no visible menu item labelled "${input.label}" (open items: ${menuText || "none"})`,
      );
    }
    if (input.checked !== undefined) {
      const hasCheck =
        (await visible[0].handle.locator("svg.lucide-check").count()) > 0 ||
        (await visible[0].handle.locator("[data-check]").count()) > 0;
      if (hasCheck !== input.checked) {
        throw new Error(
          `app.expectMenuItem: "${input.label}" expected ${input.checked ? "checked" : "unchecked"}, ` +
            `got ${hasCheck ? "checked" : "unchecked"}`,
        );
      }
    }
  },
});

const monacoEditInput = z.strictObject({
  // Text to insert into the editor.
  text: z.string().min(1),
  // Append at the end of the document (default) or replace the whole buffer.
  append: z.boolean().default(true),
  // Click the file view's Save button and wait for the PUT /file write to
  // complete and the button to return to its disabled (saved) state.
  save: z.boolean().default(false),
});

const appMonacoEdit = defineNode<typeof monacoEditInput, void, ProjectContext>({
  name: "app.monacoEdit",
  description:
    "Edit the currently open Monaco file editor (Projects/Memory file view) " +
    "deterministically via the monaco editor API, instead of steering the " +
    "editor with vision actions. The file must already be open in Edit mode " +
    "(click the Preview/Edit segmented control first). Appends text at the " +
    "end by default; set append:false to replace the whole file, and save:true " +
    "to press Save and wait for the write to finish.",
  inputSchema: monacoEditInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    // @monaco-editor/react leaves the loader global; wait for a mounted,
    // visible editor instance (the recorded-apps surface never mounts one).
    await page.waitForFunction(
      "() => (window.monaco?.editor?.getEditors?.() ?? []).some((e) => e.getDomNode()?.offsetParent)",
      null,
      { timeout: 15_000 },
    );
    // String expression on purpose: esbuild injects __name() helpers into
    // nested functions inside evaluate callbacks, which then fail in-page.
    // Playwright only forwards the second argument to *function* scripts, not
    // string expressions, so the parameters are embedded as JSON literals.
    const argJson = JSON.stringify({ text: input.text, append: input.append });
    await page.evaluate(
      "((arg) => {" +
        "  const eds = window.monaco.editor.getEditors();" +
        "  const ed = eds.find((e) => e.getDomNode()?.offsetParent) ?? eds[eds.length - 1];" +
        '  if (!ed) throw new Error("no visible monaco editor");' +
        "  if (arg.append) {" +
        "    const m = ed.getModel();" +
        "    const line = m.getLineCount();" +
        "    const col = m.getLineMaxColumn(line);" +
        '    ed.executeEdits("midscene", [{' +
        "      range: new window.monaco.Range(line, col, line, col)," +
        "      text: arg.text, forceMoveMarkers: true," +
        "    }]);" +
        "  } else {" +
        "    ed.setValue(arg.text);" +
        "  }" +
        "  ed.focus();" +
        `})(${argJson})`,
    );
    // Let React's onChange flush into the file store (enables Save).
    await page.waitForTimeout(300);
    if (input.save) {
      const saveButton = page
        .locator("main")
        .getByRole("button", { name: "Save", exact: true })
        .first();
      await saveButton.waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForFunction(
        "() => {" +
          '  const b = Array.from(document.querySelectorAll("main button"))' +
          '    .find((x) => /^Save$/.test((x.textContent || "").trim()));' +
          "  return b ? !b.disabled : false;" +
          "}",
        null,
        { timeout: 10_000 },
      );
      const putDone = page.waitForResponse(
        (response) =>
          /\/api\/(projects|memory)\/file/.test(response.url()) &&
          response.request().method() === "PUT",
        { timeout: 15_000 },
      );
      await saveButton.click();
      await putDone;
      // Button label briefly becomes "Saving"; once it reads "Save" again and
      // is disabled, the store has settled back to a clean state.
      await page.waitForFunction(
        "() => {" +
          '  const b = Array.from(document.querySelectorAll("main button"))' +
          '    .find((x) => /^Save$/.test((x.textContent || "").trim()));' +
          "  return Boolean(b && b.disabled);" +
          "}",
        null,
        { timeout: 10_000 },
      );
    }
  },
});

const appGoBack = defineNode<typeof goBackInput, void, ProjectContext>({
  name: "app.goBack",
  description:
    "Go back one entry in browser history (client-side navigation), keeping " +
    "the in-memory mock state of the current browser context.",
  inputSchema: goBackInput,
  async execute({ context }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('a[href="/chat"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
  },
});

const expectUrlInput = z.strictObject({
  // Substring matched against the full URL; prefix with "re:" for a regex.
  path: z.string().min(1),
});

const appExpectUrl = defineNode<typeof expectUrlInput, void, ProjectContext>({
  name: "app.expectUrl",
  description: "Assert the current URL matches the given substring or re: regex.",
  inputSchema: expectUrlInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const current = page.url();
    const matched = input.path.startsWith("re:")
      ? new RegExp(input.path.slice(3)).test(current)
      : current.includes(input.path);
    if (!matched) {
      throw new Error(`Expected URL to match "${input.path}" but got "${current}"`);
    }
  },
});

const reloadInput = z.strictObject({});

const appReload = defineNode<typeof reloadInput, void, ProjectContext>({
  name: "app.reload",
  description:
    "Reload the current page. The mock keeps writes in memory, so a reload " +
    "restores the default fixtures while keeping one story within a case.",
  inputSchema: reloadInput,
  async execute({ context }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator('a[href="/chat"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
  },
});

const pressKeyInput = z.strictObject({
  // Combo like "mod+k", "mod+b", "mod+shift+o", or a single key
  // "Escape"/"Enter". "mod" maps to Meta on macOS and Control elsewhere, so
  // the same case works locally and on Linux CI (Rome binds both).
  key: z.string().min(1),
});

const appPressKey = defineNode<typeof pressKeyInput, void, ProjectContext>({
  name: "app.pressKey",
  description:
    'Press a keyboard shortcut deterministically. Use "mod" for the ' +
    "platform modifier (Cmd on macOS, Ctrl on Linux/Windows).",
  inputSchema: pressKeyInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    const parts = input.key
      .toLowerCase()
      .split("+")
      .map((part) => part.trim())
      .map((part) =>
        part === "mod" ? (process.platform === "darwin" ? "Meta" : "Control") : part,
      );
    await page.keyboard.press(parts.map((p) => (p.length > 1 ? capitalize(p) : p)).join("+"));
    await page.waitForTimeout(300);
  },
});

const typeInput = z.strictObject({
  // Text to type. Omit together with clear:true to empty a field only.
  text: z.string().optional(),
  // Optional visible label/placeholder of the field to focus first.
  target: z.string().optional(),
  // Clear the field before typing (Playwright fill for React controlled
  // inputs; Ctrl/Cmd+A when typing into the already focused element).
  clear: z.boolean().default(false),
});

const appTypeText = defineNode<typeof typeInput, void, ProjectContext>({
  name: "app.typeText",
  description:
    "Focus a text field by its visible label/placeholder and type text " +
    "deterministically with the keyboard. If target is omitted, types into " +
    "the currently focused element. With clear:true and no text, empties the " +
    "field only.",
  inputSchema: typeInput,
  async execute({ context, input }) {
    const { page } = context;
    if (!page) throw new Error("No page is open; call app.open first");
    let field: Locator | undefined;
    if (input.target) {
      // Try candidate locators one at a time instead of joining them into one
      // selector: Playwright switches engines at ">>", so a comma CSS list with
      // a trailing xpath union parses as a chain and never matches.
      const candidates = [
        page.getByPlaceholder(input.target).first(),
        page.getByRole("textbox", { name: input.target }).first(),
        page.getByLabel(input.target).first(),
      ];
      for (const loc of candidates) {
        if (await loc.isVisible().catch(() => false)) {
          field = loc;
          break;
        }
      }
      if (!field) throw new Error(`app.typeText: no visible field matches "${input.target}"`);
      await field.click();
    }
    if (input.clear) {
      // Playwright fill drives React controlled inputs reliably; the
      // Ctrl/Cmd+A fallback covers the focused-field case without a target.
      if (field) {
        await field.fill("");
      } else {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
        await page.keyboard.press("Delete");
      }
    }
    if (input.text) await page.keyboard.type(input.text, { delay: 15 });
    await page.waitForTimeout(200);
  },
});

const tagList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);

export default defineTestProject<ProjectContext>({
  test: { maxConcurrency: 1, testTimeout: 8 * 60_000 },
  projects: [
    {
      name: process.env.MIDSCENE_PROJECT_NAME ?? "web",
      retry: process.env.MIDSCENE_RETRY ? Number(process.env.MIDSCENE_RETRY) : 2,
      setup,
      files: { include: ["cases/**/*.{yaml,yml}"] },
      tags: {
        include: tagList(process.env.MIDSCENE_INCLUDE_TAGS),
        exclude: tagList(process.env.MIDSCENE_EXCLUDE_TAGS),
      },
    },
  ],
  nodes: [
    ...createMidsceneNodes<ProjectContext>({ agentClass: PlaywrightAgent, getAgent }),
    appOpen,
    appReload,
    appGoBack,
    appExpectUrl,
    appClickContentLink,
    appClickByLabel,
    appExpectControl,
    appExpectMenuItem,
    appExpectTexts,
    appExpectDom,
    appMonacoEdit,
    appScrollContent,
    appScrollTextIntoView,
    appPressKey,
    appTypeText,
  ],
});
