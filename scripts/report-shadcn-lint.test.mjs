import assert from "node:assert/strict";
import test from "node:test";
import { summarizeReport } from "./report-shadcn-lint.mjs";

function report(diagnostics = []) {
  return JSON.stringify({ number_of_files: 12, diagnostics });
}

test("findings remain visible even when the scan succeeds", () => {
  const diagnostic = { code: "shadcn(no-restyle)", filename: "page.tsx", severity: "warning" };
  const result = summarizeReport(report([diagnostic, diagnostic]), "", "success");
  assert.equal(result.incomplete, false);
  assert.match(result.annotation, /2 diagnostics across 1 files/);
  assert.match(result.summary, /shadcn\(no-restyle\) \| 2/);
});

test("a clean scan and an unavailable scan have different outcomes", () => {
  const clean = summarizeReport(report(), "", "success");
  assert.equal(clean.annotation, null);
  assert.equal(clean.incomplete, false);
  assert.equal(clean.status, "No findings");
  for (const [text, outcome] of [
    ["", "skipped"],
    ["not JSON", "success"],
    ["{}", "success"],
    [JSON.stringify({ number_of_files: 0, diagnostics: [] }), "success"],
    [report([null]), "success"],
    [report(), "failure"],
  ]) {
    const result = summarizeReport(text, "", outcome);
    assert.equal(result.incomplete, true);
    assert.equal(result.status, "⚠ Scan incomplete");
    assert.match(result.summary, /Do not interpret this as zero findings/);
  }
});

test("advice and future severity names do not hide other findings", () => {
  const diagnostics = ["warning", "error", "advice", "future-severity"].map((severity) => ({
    code: "shadcn(no-restyle)",
    filename: "page.tsx",
    severity,
  }));
  const result = summarizeReport(report(diagnostics), "", "success");
  assert.equal(result.incomplete, false);
  assert.match(result.annotation, /4 diagnostics across 1 files/);
  assert.match(result.summary, /shadcn\(no-restyle\) \| 4/);
});

test("missing, blank, and non-string severities remain invalid", () => {
  for (const severity of [undefined, null, "", " \t\n", 1, false, {}, []]) {
    const result = summarizeReport(
      report([{ code: "shadcn(no-restyle)", filename: "page.tsx", severity }]),
      "",
      "success",
    );
    assert.equal(result.incomplete, true);
    assert.match(result.summary, /Do not interpret this as zero findings/);
  }
});

test("discovery warnings remain visible without rule diagnostics", () => {
  const result = summarizeReport(report(), "Theme resolution failed", "success");
  assert.ok(result.annotation);
  assert.equal(result.status, "⚠ Coverage warnings");
  assert.match(result.summary, /Discovery warnings were emitted/);
});

test("findings expose source links, repair messages, and escaped line annotations", () => {
  const result = summarizeReport(
    report([
      {
        code: "shadcn(no-restyle)",
        filename: "src/page,view.tsx",
        severity: "warning",
        message: "Use the size prop.\n::error::not a command",
        labels: [{ span: { line: 42 } }],
      },
    ]),
    "",
    "success",
    "https://github.com/rome-os/rome/blob/abc123",
  );
  assert.equal(result.status, "⚠ 1 finding");
  assert.match(result.summary, /src\/page%2Cview\.tsx#L42/);
  assert.match(result.summary, /Use the size prop/);
  assert.match(result.locationAnnotations[0], /file=src\/page%2Cview.tsx,line=42/);
  assert.doesNotMatch(result.locationAnnotations[0], /\n/);
  assert.match(result.locationAnnotations[0], /%0A::error::/);
});

test("examples and annotations are bounded without dropping findings from counts", () => {
  const diagnostics = Array.from({ length: 40 }, (_, index) => ({
    code: `rule-${index % 5}`,
    filename: `src/page-${index}.tsx`,
    severity: "warning",
    message: "Use a size variant.",
    labels: [{ span: { line: index + 1 } }],
  }));
  const result = summarizeReport(report(diagnostics), "", "success");
  assert.equal(result.status, "⚠ 40 findings");
  assert.equal(result.locationAnnotations.length, 9);
  assert.equal((result.summary.match(/Use a size variant\./g) || []).length, 20);
  assert.match(result.summary, /rule-0 \| 8/);
});

test("compatibility messages remain in totals when omitted from selected examples", () => {
  const result = summarizeReport(
    report([
      {
        code: "shadcn(no-raw-colors)",
        filename: "page.tsx",
        severity: "warning",
        message: '"text-ui" is not a declared theme color.',
        labels: [{ span: { line: 1 } }],
      },
    ]),
    "",
    "success",
  );
  assert.equal(result.status, "⚠ 1 finding");
  assert.equal(result.locationAnnotations.length, 0);
  assert.match(result.summary, /No source-located examples selected/);
});

test("rule names cannot inject Markdown or workflow commands into the summary", () => {
  const result = summarizeReport(
    report([
      {
        code: "rule|<b>`\n::error::injected",
        filename: "page.tsx",
        severity: "warning",
      },
    ]),
    "",
    "success",
  );
  assert.doesNotMatch(result.summary, /\n::error|<b>/);
  assert.match(result.summary, /rule&#124;&#60;b&#62;&#96;&#10;/);
});
