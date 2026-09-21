#!/usr/bin/env node
// Secret- and browser-free validation: load the Midscene project config,
// discover every workflow YAML, and run the same collection the runner uses
// (YAML parse, schema/unknown-key checks, custom-node resolution) without
// launching Chromium or calling the model. The pull_request CI job runs this
// so a malformed case or a broken node reference fails before merge.

import { relative, resolve, sep } from "node:path";
import { collectWorkflowDocument } from "@midscene/test";
import {
  DEFAULT_TEST_FILE_SELECTION,
  discoverTestFiles,
  loadTestProject,
} from "@midscene/test/config";

const projectRoot = process.cwd();
const configPath = resolve(projectRoot, "midscene.config.ts");

const loaded = await loadTestProject(configPath);

let fileCount = 0;
let caseCount = 0;
const failures = [];

for (const project of loaded.projects) {
  const selection = project.files ?? DEFAULT_TEST_FILE_SELECTION;
  const files = discoverTestFiles(projectRoot, selection);
  console.log(`Project "${project.name}": ${files.length} workflow file(s)`);

  for (const absolutePath of files) {
    fileCount += 1;
    const sourcePath = relative(projectRoot, absolutePath)
      .split(sep)
      .join("/");
    try {
      const document = collectWorkflowDocument(
        {
          projectId: project.projectId,
          projectName: project.name,
          sourcePath,
          absolutePath,
        },
        {
          resolveNode: project.nodes.get.bind(project.nodes),
          variables: project.variables,
          env: process.env,
        },
      );
      caseCount += document.cases.length;
    } catch (error) {
      failures.push({ sourcePath, error });
    }
  }
}

for (const { sourcePath, error } of failures) {
  console.error(
    `x ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

if (failures.length > 0) {
  console.error(
    `\nCollection failed: ${failures.length} invalid workflow file(s).`,
  );
  process.exit(1);
}

console.log(
  `Collection OK: ${caseCount} cases in ${fileCount} file(s) across ${loaded.projects.length} project(s).`,
);
