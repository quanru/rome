import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function escapeMarkdown(value) {
  return value.replace(/[&<>|`\[\]\\\r\n]/g, (character) => `&#${character.charCodeAt(0)};`);
}

function escapeCommand(value) {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(value) {
  return escapeCommand(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

function selectFindings(diagnostics) {
  const perRule = new Map();
  const selected = [];
  const seen = new Set();
  for (const diagnostic of [...diagnostics].sort((a, b) => a.filename.localeCompare(b.filename))) {
    const line = diagnostic.labels?.[0]?.span?.line;
    if (!Number.isInteger(line) || line < 1 || typeof diagnostic.message !== "string") continue;
    if (
      !diagnostic.filename ||
      diagnostic.filename.startsWith("/") ||
      diagnostic.filename.split("/").includes("..")
    )
      continue;
    if (diagnostic.message.includes("not a declared theme color")) continue;
    if (diagnostic.code === "shadcn(no-arbitrary-values)" && diagnostic.message.includes("var("))
      continue;
    const key = `${diagnostic.code}:${diagnostic.filename}:${line}`;
    if (seen.has(key) || (perRule.get(diagnostic.code) ?? 0) >= 4) continue;
    seen.add(key);
    perRule.set(diagnostic.code, (perRule.get(diagnostic.code) ?? 0) + 1);
    selected.push({ ...diagnostic, line });
    if (selected.length === 20) break;
  }
  return selected;
}

export function summarizeReport(reportText, stderr, outcome, sourceBase = "") {
  const introduction = [
    "## shadcn lint",
    "",
    "This check does not block CI. A successful job does not mean the design system has no findings.",
    "",
  ];
  let report;
  try {
    report = JSON.parse(reportText);
  } catch {
    report = null;
  }
  const valid =
    Number.isInteger(report?.number_of_files) &&
    report.number_of_files > 0 &&
    Array.isArray(report.diagnostics) &&
    report.diagnostics.every(
      (diagnostic) =>
        typeof diagnostic?.code === "string" &&
        typeof diagnostic.filename === "string" &&
        typeof diagnostic.severity === "string" &&
        diagnostic.severity.trim().length > 0,
    );
  if (outcome !== "success" || !valid) {
    return {
      incomplete: true,
      status: "⚠ Scan incomplete",
      locationAnnotations: [],
      annotation: "shadcn lint did not complete. This is not a clean scan. Inspect the job logs.",
      summary: introduction
        .concat(
          "**Scan incomplete or unavailable. Do not interpret this as zero findings.**",
          "",
          "Inspect setup/scan step logs and the diagnostic log groups, if available.",
          "Reproduce with `pnpm lint:shadcn`. See DEVELOPMENT.md for scope and known limitations.",
          "",
        )
        .join("\n"),
    };
  }

  const counts = new Map();
  for (const diagnostic of report.diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  const findings = report.diagnostics.length;
  const files = new Set(report.diagnostics.map((diagnostic) => diagnostic.filename)).size;
  const selected = selectFindings(report.diagnostics);
  const status = findings
    ? `⚠ ${findings} ${findings === 1 ? "finding" : "findings"}`
    : stderr.trim()
      ? "⚠ Coverage warnings"
      : "No findings";
  const examples = selected.map((diagnostic) => {
    const label = escapeMarkdown(`${diagnostic.filename}:${diagnostic.line}`);
    const path = diagnostic.filename
      .split("/")
      .map(encodeURIComponent)
      .join("/")
      .replaceAll("(", "%28")
      .replaceAll(")", "%29");
    const location = sourceBase ? `[${label}](${sourceBase}/${path}#L${diagnostic.line})` : label;
    return `| ${location} | ${escapeMarkdown(diagnostic.code)} | ${escapeMarkdown(diagnostic.message)} |`;
  });
  const summary = introduction
    .concat(
      `Scanned **${report.number_of_files} files**: **${findings} diagnostics** across **${files} files**.`,
      `**${status}**`,
      "",
      "| Rule | Diagnostics |",
      "| --- | ---: |",
      ...[...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rule, count]) => `| ${escapeMarkdown(rule)} | ${count} |`),
      "",
      stderr.trim()
        ? "**Discovery warnings were emitted. Check the stderr log group before judging coverage.**"
        : "No stderr diagnostics were emitted.",
      "",
      "Known noise: named typography and shadow tokens can be mistaken for colors. Token references can be reported as arbitrary values.",
      "Review findings in changed files against DESIGN.md. Do not invent color tokens or change intentional brand artwork to silence warnings.",
      "",
      "### Findings to inspect",
      "",
      "Up to 20 examples, with at most four per rule. Undeclared-color and CSS-variable arbitrary-value messages are omitted from this selection because they need token compatibility review. All diagnostics remain in the totals and logs.",
      "",
      "| Source | Rule | Finding and suggested repair |",
      "| --- | --- | --- |",
      ...examples,
      ...(selected.length
        ? []
        : [
            "| — | — | No source-located examples selected. Review the full logs for any remaining findings. |",
          ]),
      "",
      "Read the diagnostic log groups for all source locations and messages. Reproduce with `pnpm lint:shadcn`.",
      "Agents: report actionable findings, known noise, and any coverage limits in the handoff. See DEVELOPMENT.md for details.",
      "",
    )
    .join("\n");
  return {
    incomplete: false,
    status,
    locationAnnotations: selected
      .slice(0, 9)
      .map(
        (diagnostic) =>
          `::warning file=${escapeProperty(diagnostic.filename)},line=${diagnostic.line},title=${escapeProperty(diagnostic.code)}::${escapeCommand(diagnostic.message)}`,
      ),
    annotation:
      findings || stderr.trim()
        ? `shadcn lint: ${findings} diagnostics across ${files} files. Review the job summary and diagnostic log groups; known token false positives apply.`
        : null,
    summary,
  };
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, stderrPath, outcome] = process.argv.slice(2);
  const reportText = readOptional(reportPath);
  const stderr = readOptional(stderrPath);
  const sourceBase =
    process.env.GITHUB_REPOSITORY && process.env.GITHUB_SHA
      ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/blob/${process.env.GITHUB_SHA}`
      : "";
  const result = summarizeReport(reportText, stderr, outcome, sourceBase);
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.summary);
  }
  console.log(result.summary);
  if (result.annotation) console.log(`::warning title=shadcn lint::${result.annotation}`);
  for (const annotation of result.locationAnnotations) console.log(annotation);
  for (const [title, contents] of [
    ["shadcn JSON diagnostics", reportText],
    ["shadcn stderr", stderr],
  ]) {
    const token = randomUUID();
    console.log(`::group::${title}`);
    console.log(`::stop-commands::${token}`);
    console.log(contents || "(no output)");
    console.log(`::${token}::`);
    console.log("::endgroup::");
  }
  if (result.incomplete) process.exitCode = 1;
}
