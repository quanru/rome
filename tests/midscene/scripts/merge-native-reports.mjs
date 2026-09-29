#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { mergeReportFiles } from "@midscene/core";

import { collectReportData } from "./render-ci-summary.mjs";

export async function mergeNativeReports(reportsDirectory, expectedProjects) {
  const directory = path.resolve(reportsDirectory);
  const { projects } = await collectReportData(directory, expectedProjects);
  const htmlPaths = projects
    .filter((project) => project.reportPath)
    .map((project) => path.join(directory, project.reportPath));
  if (!htmlPaths.length) return null;

  return mergeReportFiles({
    htmlPaths,
    outputDir: directory,
    outputName: "native-report",
  }).mergedReportPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [reportsDirectory, projects] = process.argv.slice(2);
  if (!reportsDirectory || !projects) {
    throw new Error("Usage: merge-native-reports.mjs <reports-dir> <comma-separated-projects>");
  }
  const report = await mergeNativeReports(reportsDirectory, projects.split(","));
  if (report) process.stdout.write(`${report}\n`);
}
