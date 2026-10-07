import assert from "node:assert/strict";
import test from "node:test";
import { findPreviousReport, isTrustedReportRun } from "./trusted-report-runs.mjs";

const upstream = {
  repository: { full_name: "rome-os/rome" },
  head_repository: { full_name: "rome-os/rome" },
  path: ".github/workflows/midscene.yml",
  status: "completed",
  head_branch: "main",
  event: "push",
};

test("report sources reject PR artifacts, other workflows, and untrusted refs", () => {
  assert.equal(isTrustedReportRun(upstream, "rome-os/rome"), true);
  assert.equal(
    isTrustedReportRun({ ...upstream, event: "workflow_dispatch" }, "rome-os/rome"),
    true,
  );
  for (const change of [
    { event: "pull_request" },
    { event: "pull_request_target" },
    { head_repository: { full_name: "attacker/rome" } },
    { repository: { full_name: "other/rome" } },
    { head_repository: null },
    { head_branch: "feature" },
    { path: ".github/workflows/other.yml" },
    { status: "in_progress" },
  ])
    assert.equal(isTrustedReportRun({ ...upstream, ...change }, "rome-os/rome"), false);
});

test("fork reports require a same-repository manual dispatch", () => {
  const fork = {
    ...upstream,
    repository: { full_name: "example/rome" },
    head_repository: { full_name: "example/rome" },
    event: "workflow_dispatch",
    head_branch: "feature",
  };
  assert.equal(isTrustedReportRun(fork, "example/rome"), true);
  assert.equal(isTrustedReportRun({ ...fork, event: "pull_request" }, "example/rome"), false);
  assert.equal(isTrustedReportRun({ ...fork, event: "push" }, "example/rome"), false);
});

test("history skips attacker-named artifacts and uses the latest trusted run", async () => {
  const artifacts = [
    { name: "midscene-e2e-report-pages-1", workflow_run: { id: 1 } },
    { name: "midscene-e2e-report-pages-2", workflow_run: { id: 2 } },
  ];
  const selected = await findPreviousReport(
    artifacts,
    "rome-os/rome",
    async (id) => (id === 1 ? { ...upstream, event: "pull_request" } : upstream),
    "3",
  );
  assert.equal(selected, artifacts[1]);
  assert.equal(
    await findPreviousReport(
      artifacts,
      "rome-os/rome",
      async () => ({ ...upstream, event: "pull_request" }),
      "3",
    ),
    null,
  );
});
