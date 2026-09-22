#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const parseArguments = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}`);
    }
    options[key.slice(2)] = value;
  }
  return options;
};

const walk = async (directory, predicate) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })) {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(item, predicate)));
    else if (entry.isFile() && predicate(item)) files.push(item);
  }
  return files;
};

const formatDuration = (durationMs) => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "—";
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
};

const markdownCell = (value) =>
  String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

const html = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const newest = (left, right) =>
  Date.parse(left.startedAt ?? "") >= Date.parse(right.startedAt ?? "") ? left : right;

const loadAttempt = async (summaryFile, attempt) => {
  if (!attempt?.resultFile) return null;
  const resultFile = path.join(path.dirname(summaryFile), attempt.resultFile);
  return JSON.parse(await readFile(resultFile, "utf8"));
};

const failureReason = (attempt) => {
  const steps = [
    ...(attempt?.beforeEach ?? []),
    ...(attempt?.steps ?? []),
    ...(attempt?.afterEach ?? []),
  ];
  const failed = steps.findLast((step) => step?.status === "failed") ?? attempt;
  const value = failed?.error?.message ?? failed?.error ?? failed?.output?.summary;
  return typeof value === "string" && value.trim() ? value.trim() : "Midscene case failed";
};

const modelsFromReports = async (directory) => {
  const models = new Set();
  const metadataFiles = await walk(directory, (file) => path.basename(file) === "model.json");
  for (const file of metadataFiles) {
    const metadata = JSON.parse(await readFile(file, "utf8"));
    if (metadata.modelName) {
      models.add(
        metadata.modelFamily
          ? `${metadata.modelName} (${metadata.modelFamily})`
          : metadata.modelName,
      );
    }
  }
  if (models.size) return [...models].sort();
  const reports = await walk(directory, (file) => file.endsWith(".html"));
  for (const report of reports) {
    const source = await readFile(report, "utf8");
    for (const match of source.matchAll(/"modelName"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
      try {
        const model = JSON.parse(match[1]);
        if (model) models.add(model);
      } catch {}
    }
  }
  return [...models].sort();
};

const nativeReportFor = async (reportsDirectory, record) => {
  if (record.report) {
    const report = path.resolve(path.dirname(record.summaryFile), record.report);
    return path.relative(reportsDirectory, report).split(path.sep).join("/");
  }
  const { summaryFile } = record;
  const artifactRoot = summaryFile.slice(0, summaryFile.indexOf(`${path.sep}.midscene${path.sep}`));
  const reports = (
    await walk(path.join(artifactRoot, "midscene_run", "report"), (file) => file.endsWith(".html"))
  ).filter((file) => {
    const name = path.basename(file);
    const parent = path.basename(path.dirname(file));
    return (
      name.startsWith("test-run-") ||
      name.startsWith("midscene-e2e-") ||
      parent.startsWith("midscene-e2e-")
    );
  });
  const report = reports.sort().at(-1);
  return report ? path.relative(reportsDirectory, report).split(path.sep).join("/") : null;
};

export async function collectReportData(reportsDirectory, expectedProjects = []) {
  const summaryFiles = await walk(
    reportsDirectory,
    (file) => path.basename(file) === "summary.json",
  );
  const summariesByProject = new Map();
  for (const summaryFile of summaryFiles) {
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    for (const project of summary.projects ?? []) {
      const record = { ...summary, project, summaryFile };
      const previous = summariesByProject.get(project.name);
      summariesByProject.set(project.name, previous ? newest(previous, record) : record);
    }
  }

  const projectNames = expectedProjects.length
    ? expectedProjects
    : [...summariesByProject.keys()].sort((left, right) =>
        left.localeCompare(right, undefined, { numeric: true }),
      );
  const projects = [];
  for (const name of projectNames) {
    const record = summariesByProject.get(name);
    if (!record) {
      projects.push({ name, status: "missing", durationMs: null, reportPath: null, cases: [] });
      continue;
    }
    const cases = [];
    for (const testCase of record.project.cases ?? []) {
      const attemptRef = testCase.attempts?.at(-1);
      const attempt = await loadAttempt(record.summaryFile, attemptRef).catch(() => null);
      cases.push({
        name: testCase.name,
        status: testCase.status,
        durationMs: attempt?.durationMs ?? null,
        reason: testCase.status === "success" ? "" : failureReason(attempt),
      });
    }
    projects.push({
      name,
      status: record.project.status,
      durationMs: record.project.lifecycle?.durationMs ?? record.durationMs,
      reportPath: await nativeReportFor(reportsDirectory, record),
      cases,
    });
  }
  return { projects, models: await modelsFromReports(reportsDirectory) };
}

const totalsFor = (projects) => {
  const cases = projects.flatMap((project) =>
    project.cases.map((testCase) => ({ ...testCase, project: project.name })),
  );
  const passed = cases.filter((testCase) => testCase.status === "success").length;
  return { cases, passed, failed: cases.length - passed, total: cases.length };
};

export function renderMarkdown({ projects, models, runUrl, producerResult = "success" }) {
  const totals = totalsFor(projects);
  const complete = producerResult === "success" && totals.total > 0 && totals.failed === 0;
  const sections = [
    `## Rome × Midscene · ${complete ? "passed" : "failure captured"}`,
    "",
    `**${totals.passed}/${totals.total} cases · ${totals.total ? Math.round((totals.passed / totals.total) * 100) : 0}% passed**`,
    "",
    `**Models:** ${models.length ? models.map(markdownCell).join(", ") : "not recorded"}`,
    "",
    `**[Download the combined HTML report](${runUrl}#artifacts)**`,
    "",
    "| Shard | Passed | Failed | Duration |",
    "|:--|--:|--:|--:|",
    ...projects.map((project) => {
      const passed = project.cases.filter((testCase) => testCase.status === "success").length;
      const failed = project.cases.length - passed;
      const label = project.status === "missing" ? `${project.name} (missing)` : project.name;
      return `| ${markdownCell(label)} | ${passed} | ${failed} | ${formatDuration(project.durationMs)} |`;
    }),
    "",
  ];

  const failures = totals.cases.filter((testCase) => testCase.status !== "success");
  if (failures.length) {
    sections.push(
      `### Failures (${failures.length})`,
      "",
      "| Case | Shard | Duration | Reason |",
      "|:--|:--|--:|:--|",
      ...failures.map(
        (testCase) =>
          `| ❌ ${markdownCell(testCase.name)} | ${markdownCell(testCase.project)} | ${formatDuration(testCase.durationMs)} | ${markdownCell(testCase.reason)} |`,
      ),
      "",
    );
  } else {
    sections.push(`**All ${totals.total} cases passed.**`, "");
  }

  sections.push(
    "<details>",
    `<summary>All cases (${totals.total})</summary>`,
    "",
    "| | Case | Shard | Duration |",
    "|:--:|:--|:--|--:|",
    ...totals.cases.map(
      (testCase) =>
        `| ${testCase.status === "success" ? "✅" : "❌"} | ${markdownCell(testCase.name)} | ${markdownCell(testCase.project)} | ${formatDuration(testCase.durationMs)} |`,
    ),
    "",
    "</details>",
    "",
  );
  return sections.join("\n");
}

export function renderHtml({ projects, models, runUrl }) {
  const totals = totalsFor(projects);
  const rows = totals.cases
    .map((testCase) => {
      const project = projects.find((item) => item.name === testCase.project);
      const caseName = project?.reportPath
        ? `<a href="${html(project.reportPath)}">${html(testCase.name)}</a>`
        : html(testCase.name);
      return `<tr><td class="status">${testCase.status === "success" ? "✅" : "❌"}</td><td>${caseName}</td><td>${html(testCase.project)}</td><td>${html(formatDuration(testCase.durationMs))}</td><td>${html(testCase.reason)}</td></tr>`;
    })
    .join("\n");
  const shardRows = projects
    .map((project) => {
      const passed = project.cases.filter((testCase) => testCase.status === "success").length;
      const failed = project.cases.length - passed;
      const name = project.reportPath
        ? `<a href="${html(project.reportPath)}">${html(project.name)}</a>`
        : html(`${project.name} (missing)`);
      return `<tr><td>${name}</td><td>${passed}</td><td>${failed}</td><td>${html(formatDuration(project.durationMs))}</td></tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Rome × Midscene Summary</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:1200px;margin:40px auto;padding:0 24px;color:#172033}h1{margin-bottom:4px}.meta{color:#596579}table{width:100%;border-collapse:collapse;margin:20px 0 32px}th,td{border:1px solid #d8dee9;padding:9px 12px;text-align:left;vertical-align:top}th{background:#f4f6f8}.status{width:30px;text-align:center}a{color:#0969da}code{background:#f4f6f8;padding:2px 5px;border-radius:4px}</style></head>
<body><h1>Rome × Midscene Summary</h1>
<p class="meta"><strong>${totals.passed}/${totals.total} cases passed</strong> · Models: ${html(models.join(", ") || "not recorded")} · <a href="${html(runUrl)}">Actions run</a></p>
<h2>Shards</h2><table><thead><tr><th>Shard</th><th>Passed</th><th>Failed</th><th>Duration</th></tr></thead><tbody>${shardRows}</tbody></table>
<h2>Cases</h2><table><thead><tr><th></th><th>Case</th><th>Shard</th><th>Duration</th><th>Failure</th></tr></thead><tbody>${rows}</tbody></table></body></html>\n`;
}

export async function buildSummary(options) {
  const reportsDirectory = path.resolve(options["reports-dir"]);
  const expectedProjects = (options["expected-projects"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const data = await collectReportData(reportsDirectory, expectedProjects);
  const values = {
    ...data,
    runUrl: options["run-url"],
    producerResult: options["producer-result"],
  };
  if (options.output) await appendFile(options.output, `${renderMarkdown(values)}\n`);
  if (options["html-output"]) {
    const output = path.resolve(options["html-output"]);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, renderHtml(values));
  }
  return values;
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  buildSummary(parseArguments(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
