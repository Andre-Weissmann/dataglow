#!/usr/bin/env node
/**
 * DataGlow — Connect Prompt Eval Runner to the Verifiable Build Log
 *
 * Reads the most recent prompt evaluation report
 * (test/prompt-eval/last-run.json, produced by test/prompt-eval/runner.js)
 * and appends a summarized entry to dev-log/checkpoints.json, DataGlow's
 * Verifiable Build Log.
 *
 * This turns every prompt-eval run into a timestamped, hash-identified
 * record in the project's audit trail, instead of an ephemeral local
 * file that gets overwritten on the next run.
 *
 * Usage:
 *   node scripts/append-eval-to-build-log.js
 *
 * Exit code: 0 on success, 1 if either input file is missing/invalid.
 *
 * Node built-ins only — no npm installs required.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const LAST_RUN_PATH = path.join(REPO_ROOT, 'test', 'prompt-eval', 'last-run.json');
const CHECKPOINTS_PATH = path.join(REPO_ROOT, 'dev-log', 'checkpoints.json');

/**
 * Read and parse a JSON file, throwing a descriptive error on failure.
 * @param {string} filePath
 * @returns {any}
 */
function readJson(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Could not read ${filePath}: ${err.message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Could not parse ${filePath} as JSON: ${err.message}`);
  }
}

/**
 * Build the checkpoint entry to append, sourced entirely from the
 * prompt eval runner's last-run.json report.
 *
 * @param {object} lastRun - Parsed contents of test/prompt-eval/last-run.json
 * @returns {object} A single checkpoint entry.
 */
function buildCheckpointEntry(lastRun) {
  const {
    runAt,
    passRate,
    totalCases,
    passed,
    failed,
    runHash,
  } = lastRun;

  return {
    timestamp: runAt,
    type: 'prompt-eval',
    passRate,
    totalCases,
    passed,
    failed,
    runHash,
    note: 'Automated prompt evaluation run — Guarded Copilot + Query Sentinel',
  };
}

function main() {
  let lastRun;
  let checkpoints;

  try {
    lastRun = readJson(LAST_RUN_PATH);
  } catch (err) {
    console.error(err.message);
    console.error('Run `node test/prompt-eval/runner.js` first to produce a report.');
    process.exit(1);
    return;
  }

  try {
    checkpoints = readJson(CHECKPOINTS_PATH);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
    return;
  }

  if (!Array.isArray(checkpoints)) {
    console.error(`${CHECKPOINTS_PATH} must contain a JSON array.`);
    process.exit(1);
    return;
  }

  const entry = buildCheckpointEntry(lastRun);
  checkpoints.push(entry);

  fs.writeFileSync(CHECKPOINTS_PATH, JSON.stringify(checkpoints, null, 2) + '\n');

  const hashPreview = typeof entry.runHash === 'string'
    ? entry.runHash.slice(0, 12)
    : String(entry.runHash);

  console.log(
    `Appended eval run ${hashPreview} to dev-log/checkpoints.json — ` +
    `${entry.passed}/${entry.totalCases} passed`
  );
}

main();
