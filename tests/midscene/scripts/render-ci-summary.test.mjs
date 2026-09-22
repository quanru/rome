import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSummary, renderMarkdown } from "./render-ci-summary.mjs";

const writeShard = async (root, shard, status, caseName, modelName) => {
  const project = `web-${shard}`;
  const resultRoot = path.join(root, `midscene-${shard}`, ".midscene", "test-results", "run-1");
  const resultFile = path.join(resultRoot, "project-0", "case-1", "attempt.json");
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(
    resultFile,
    JSON.stringify({
      status,
      durationMs: 12_400,
      steps:
        status === "success" ? [] : [{ status: "failed", error: { message: "button missing" } }],
    }),
  );
  await writeFile(
    path.join(resultRoot, "summary.json"),
    JSON.stringify({
      startedAt: "2026-09-22T01:00:00Z",
      durationMs: 13_000,
      report: "../../../midscene_run/report/midscene-e2e-run-1/index.html",
      projects: [
        {
          name: project,
          status,
          lifecycle: { durationMs: 13_000 },
          cases: [
            {
              name: caseName,
              status,
              attempts: [{ resultFile: "project-0/case-1/attempt.json" }],
            },
          ],
        },
      ],
    }),
  );
  const reportRoot = path.join(
    root,
    `midscene-${shard}`,
    "midscene_run",
    "report",
    "midscene-e2e-run-1",
  );
  await mkdir(reportRoot, { recursive: true });
  await writeFile(
    path.join(reportRoot, "index.html"),
    `<script>window.x={"modelName":"${modelName}"}</script>`,
  );
  await writeFile(
    path.join(root, `midscene-${shard}`, "midscene_run", "model.json"),
    JSON.stringify({ modelName, modelFamily: "deepseek" }),
  );
};

test("builds one combined Markdown and HTML Summary for all shards", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "rome-midscene-summary-"));
  context.after(() =>
    import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })),
  );
  await writeShard(root, "shard-1", "success", "AUTH-01 opens chat", "deepseek-v3.2");
  await writeShard(root, "shard-2", "failed", "CHAT-09 sends a message", "deepseek-v3.2");
  const markdownFile = path.join(root, "summary.md");
  const htmlFile = path.join(root, "index.html");

  const data = await buildSummary({
    "reports-dir": root,
    "expected-projects": "web-shard-1,web-shard-2,web-shard-3",
    "run-url": "https://github.com/quanru/rome/actions/runs/1",
    "producer-result": "failure",
    output: markdownFile,
    "html-output": htmlFile,
  });

  assert.deepEqual(data.models, ["deepseek-v3.2 (deepseek)"]);
  const markdown = await readFile(markdownFile, "utf8");
  assert.match(markdown, /Rome × Midscene · failure captured/);
  assert.match(markdown, /1\/2 cases · 50% passed/);
  assert.match(markdown, /web-shard-3 \(missing\)/);
  assert.match(markdown, /CHAT-09 sends a message.*button missing/);
  const page = await readFile(htmlFile, "utf8");
  assert.match(page, /Rome × Midscene Summary/);
  assert.match(page, /deepseek-v3\.2/);
  assert.match(page, /midscene-shard-1\/midscene_run\/report\/midscene-e2e-run-1\/index\.html/);
});

test("escapes Markdown table content", () => {
  const markdown = renderMarkdown({
    projects: [
      {
        name: "web|shard",
        status: "failed",
        durationMs: 1000,
        cases: [
          { name: "Case | name", status: "failed", durationMs: 1000, reason: "line 1\nline 2" },
        ],
      },
    ],
    models: [],
    runUrl: "https://example.test/run",
    producerResult: "failure",
  });
  assert.match(markdown, /web\\\|shard/);
  assert.match(markdown, /Case \\\| name/);
  assert.match(markdown, /line 1 line 2/);
});
