import assert from "node:assert/strict";
import test from "node:test";
import {
  findPreviousReport,
  findReportHistory,
  isTrustedReportRun,
} from "./trusted-report-runs.mjs";

const upstream = {
  repository: { full_name: "rome-os/rome" },
  head_repository: { full_name: "rome-os/rome" },
  path: ".github/workflows/midscene.yml",
  status: "completed",
  head_branch: "main",
  event: "push",
  head_sha: "a".repeat(40),
};

const compareToMain = async () => ({ status: "ahead" });
const trusted = (run, repository) => isTrustedReportRun(run, repository, compareToMain);

test("report sources reject PR artifacts, other workflows, and untrusted refs", async () => {
  assert.equal(await trusted(upstream, "rome-os/rome"), true);
  assert.equal(await trusted({ ...upstream, event: "workflow_dispatch" }, "rome-os/rome"), true);
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
    assert.equal(await trusted({ ...upstream, ...change }, "rome-os/rome"), false);
});

test("fork reports require a same-repository manual dispatch", async () => {
  const fork = {
    ...upstream,
    repository: { full_name: "example/rome" },
    head_repository: { full_name: "example/rome" },
    event: "workflow_dispatch",
    head_branch: "feature",
  };
  assert.equal(await trusted(fork, "example/rome"), true);
  assert.equal(await trusted({ ...fork, event: "pull_request" }, "example/rome"), false);
  assert.equal(await trusted({ ...fork, event: "push" }, "example/rome"), false);
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
    compareToMain,
  );
  assert.equal(selected, artifacts[1]);
  assert.equal(
    await findPreviousReport(
      artifacts,
      "rome-os/rome",
      async () => ({ ...upstream, event: "pull_request" }),
      "3",
      compareToMain,
    ),
    null,
  );
});

test("an upstream tag named main must still point to a protected-main commit", async () => {
  for (const status of ["behind", "diverged"]) {
    assert.equal(
      await isTrustedReportRun(
        { ...upstream, event: "workflow_dispatch" },
        "rome-os/rome",
        async () => ({ status }),
      ),
      false,
    );
  }
  assert.equal(
    await isTrustedReportRun(upstream, "rome-os/rome", async () => ({ status: "identical" })),
    true,
  );
});

test("history searches beyond the first page of unrelated repository artifacts", async () => {
  const pages = [];
  const trustedArtifact = { name: "midscene-e2e-report-pages-1", workflow_run: { id: 1 } };
  const selected = await findReportHistory(
    async (page) => {
      pages.push(page);
      return page === 1
        ? Array.from({ length: 100 }, () => ({ name: "unrelated" }))
        : [trustedArtifact];
    },
    "rome-os/rome",
    async () => upstream,
    "3",
    compareToMain,
  );
  assert.equal(selected, trustedArtifact);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(
    await findReportHistory(
      async () => [],
      "rome-os/rome",
      async () => upstream,
      "3",
      compareToMain,
    ),
    null,
  );
});
