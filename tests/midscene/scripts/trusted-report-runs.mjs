import { appendFile } from "node:fs/promises";

export async function isTrustedReportRun(run, repository, compareToMain) {
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.path !== ".github/workflows/midscene.yml" ||
    run.status !== "completed"
  )
    return false;
  if (repository !== "rome-os/rome") return run.event === "workflow_dispatch";
  if (
    run.head_branch !== "main" ||
    !["schedule", "push", "workflow_dispatch"].includes(run.event) ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")
  )
    return false;
  // Dispatch metadata can also name a tag "main". Require commit ancestry.
  const comparison = await compareToMain(run.head_sha);
  return ["ahead", "identical"].includes(comparison.status);
}

export async function findPreviousReport(
  artifacts,
  repository,
  getRun,
  currentRunId,
  compareToMain,
) {
  for (const artifact of artifacts) {
    if (artifact.expired || !/^midscene-e2e-report-pages-\d+$/.test(artifact.name)) continue;
    const runId = artifact.workflow_run?.id;
    if (!runId || String(runId) === String(currentRunId)) continue;
    try {
      if (await isTrustedReportRun(await getRun(runId), repository, compareToMain)) return artifact;
    } catch (error) {
      process.stderr.write(`Skipping report history run ${runId}: ${error.message}\n`);
    }
  }
  return null;
}

export async function findReportHistory(
  getArtifacts,
  repository,
  getRun,
  currentRunId,
  compareToMain,
) {
  for (let page = 1; ; page += 1) {
    const artifacts = await getArtifacts(page);
    const artifact = await findPreviousReport(
      artifacts,
      repository,
      getRun,
      currentRunId,
      compareToMain,
    );
    if (artifact || artifacts.length < 100) return artifact;
  }
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
  let mainSha;
  const compareToMain = async (sha) => {
    mainSha ??= (await get("branches/main")).commit.sha;
    return get(`compare/${sha}...${mainSha}`);
  };
  if (mode === "validate-source") {
    const runId = process.env.REPORT_SOURCE_RUN_ID;
    if (!/^\d+$/.test(runId ?? "")) throw new Error("Report source run ID must be numeric");
    if (!(await isTrustedReportRun(await getRun(runId), repository, compareToMain))) {
      throw new Error(
        "Report source must be a completed, same-repository Midscene run from a trusted event/ref",
      );
    }
  } else if (mode === "find-previous") {
    const artifact = await findReportHistory(
      async (page) => (await get(`actions/artifacts?per_page=100&page=${page}`)).artifacts,
      repository,
      getRun,
      process.env.GITHUB_RUN_ID,
      compareToMain,
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
