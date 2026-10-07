import { appendFile } from "node:fs/promises";

export function isTrustedReportRun(run, repository) {
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.path !== ".github/workflows/midscene.yml" ||
    run.status !== "completed"
  )
    return false;
  return repository === "rome-os/rome"
    ? run.head_branch === "main" && ["push", "workflow_dispatch"].includes(run.event)
    : run.event === "workflow_dispatch";
}

export async function findPreviousReport(artifacts, repository, getRun, currentRunId) {
  for (const artifact of artifacts) {
    if (artifact.expired || !/^midscene-e2e-report-pages-\d+$/.test(artifact.name)) continue;
    const runId = artifact.workflow_run?.id;
    if (!runId || String(runId) === String(currentRunId)) continue;
    if (isTrustedReportRun(await getRun(runId), repository)) return artifact;
  }
  return null;
}

async function main(mode) {
  const repository = process.env.GITHUB_REPOSITORY;
  const get = async (resource) => {
    const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${repository}/${resource}`, {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!response.ok) throw new Error(`GitHub ${resource}: HTTP ${response.status}`);
    return response.json();
  };
  const getRun = (id) => get(`actions/runs/${id}`);
  if (mode === "validate-source") {
    const runId = process.env.REPORT_SOURCE_RUN_ID;
    if (!/^\d+$/.test(runId ?? "")) throw new Error("Report source run ID must be numeric");
    if (!isTrustedReportRun(await getRun(runId), repository)) {
      throw new Error(
        "Report source must be a completed, same-repository Midscene run from a trusted event/ref",
      );
    }
  } else if (mode === "find-previous") {
    const { artifacts } = await get("actions/artifacts?per_page=100");
    const artifact = await findPreviousReport(
      artifacts,
      repository,
      getRun,
      process.env.GITHUB_RUN_ID,
    );
    if (artifact) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `name=${artifact.name}\nrun_id=${artifact.workflow_run.id}\n`,
      );
    }
  } else {
    throw new Error(`Unknown mode: ${mode}`);
  }
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main(process.argv[2]).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
