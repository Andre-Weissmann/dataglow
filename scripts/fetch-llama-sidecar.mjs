#!/usr/bin/env node
/**
 * Fetch or stub a llama.cpp server binary for the Tauri desktop build.
 *
 * WHAT THIS IS FOR.
 * The desktop shell can run a much larger model than a browser tab can, by
 * talking to a llama.cpp server on the loopback interface. Tauri ships such a
 * process as an `externalBin` sidecar, and it resolves each entry to a file
 * named for the target triple at bundle time. Get that name wrong and the build
 * fails with a message that does not tell you the name is wrong.
 *
 * So this script exists to put the right file in the right place with the right
 * name, and to be the one place that knows what the right name is. The naming
 * itself comes from js/ai/llama-sidecar-packaging.js, which is also what the
 * test suite asserts against, so the script and the check cannot drift.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO.
 *   - It does not run in CI. A llama.cpp release asset is tens of megabytes and
 *     downloading one on every build to prove a naming convention is a poor
 *     trade. The convention is proven by a unit test instead.
 *   - It does not commit anything. src-tauri/binaries/ is git-ignored.
 *   - It does not download a model. Weights are hundreds of megabytes and every
 *     model has its own licence. Choosing one is a decision this script has no
 *     business making on anyone's behalf.
 *   - It does not edit tauri.conf.json. Filling externalBin is a deliberate act
 *     that has to happen when binaries exist for every target being built, and
 *     it has to happen together with flipping bundledInThisBuild.
 *
 * Usage:
 *   node scripts/fetch-llama-sidecar.mjs --list
 *   node scripts/fetch-llama-sidecar.mjs --stub
 *   node scripts/fetch-llama-sidecar.mjs --stub --triple aarch64-apple-darwin
 *   node scripts/fetch-llama-sidecar.mjs --from ./llama-server --triple x86_64-unknown-linux-gnu
 *   node scripts/fetch-llama-sidecar.mjs --check
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SIDECAR_BASENAME,
  SIDECAR_DIR,
  EXTERNAL_BIN_ENTRY,
  TARGET_TRIPLES,
  sidecarFileName,
  expectedSidecarPaths,
  sidecarPresence,
  checkPackagingAgreement,
} from '../js/ai/llama-sidecar-packaging.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI_DIR = join(ROOT, 'src-tauri');
const OUT_DIR = join(TAURI_DIR, SIDECAR_DIR);

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return null;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}

function has(name) {
  return process.argv.indexOf('--' + name) >= 0;
}

/** The triple of the machine running this, when nobody named one. */
function hostTriple() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return arch + '-apple-darwin';
  if (process.platform === 'win32') return 'x86_64-pc-windows-msvc';
  return arch + '-unknown-linux-gnu';
}

function presentTriples() {
  if (!existsSync(OUT_DIR)) return [];
  return TARGET_TRIPLES
    .filter(t => existsSync(join(TAURI_DIR, sidecarFileName(t.triple))))
    .map(t => t.triple);
}

function list() {
  console.log('Tauri resolves externalBin entries to a file per target triple.');
  console.log('Entry when shipped: ' + EXTERNAL_BIN_ENTRY + '\n');
  for (const t of expectedSidecarPaths()) {
    const there = existsSync(join(TAURI_DIR, t.path));
    console.log('  ' + (there ? 'present' : 'absent ') + '  ' + t.os + ' ' + t.arch + '  ' + t.fullPath);
  }
}

function check() {
  const confPath = join(TAURI_DIR, 'tauri.conf.json');
  let externalBin = [];
  try {
    const conf = JSON.parse(readFileSync(confPath, 'utf8'));
    externalBin = (conf.tauri && conf.tauri.bundle && conf.tauri.bundle.externalBin) || [];
  } catch (e) {
    console.error('Could not read ' + confPath + ': ' + e.message);
    process.exit(2);
  }
  const present = presentTriples();
  const agreement = checkPackagingAgreement({ externalBin, presentTriples: present, statusBundled: false });
  const presence = sidecarPresence({ triple: hostTriple(), presentTriples: present });

  console.log('externalBin: ' + JSON.stringify(externalBin));
  console.log('vendored   : ' + (present.length ? present.join(', ') : 'nothing'));
  console.log('status     : ' + presence.state);
  console.log(agreement.reason);
  for (const p of agreement.problems) console.log('  problem: ' + p);
  process.exit(agreement.ok ? 0 : 1);
}

function place(triple, sourcePath, stub) {
  const rel = sidecarFileName(triple);
  if (!rel) {
    console.error('Unknown target triple: ' + triple);
    console.error('Known: ' + TARGET_TRIPLES.map(t => t.triple).join(', '));
    process.exit(2);
  }
  const dest = join(TAURI_DIR, rel);
  mkdirSync(dirname(dest), { recursive: true });

  if (stub) {
    // A stub is for exercising the packaging path locally without a download.
    // It is a script that refuses to serve, so a status built from a handshake
    // with it reports error rather than ready. A stub that pretended to work
    // would defeat the point of having an honest status at all.
    const body = process.platform === 'win32'
      ? '@echo off\r\necho DataGlow llama sidecar stub. Not a real server.\r\nexit /b 1\r\n'
      : '#!/bin/sh\necho "DataGlow llama sidecar stub. Not a real server." >&2\nexit 1\n';
    writeFileSync(dest, body);
    try { chmodSync(dest, 0o755); } catch (_e) {}
    console.log('Wrote a stub at ' + dest);
    console.log('It exits non-zero on purpose, so a handshake against it fails and the status stays honest.');
    return;
  }

  if (!sourcePath) {
    console.error('No --from path given and --stub was not passed, so there is nothing to place.\n');
    console.error('Get a binary one of these two ways, then re-run with --from:\n');
    console.error('  1. Download a release build for your platform from the llama.cpp releases page');
    console.error('     and unpack it. The file you want is llama-server (llama-server.exe on Windows).\n');
    console.error('  2. Build it:  cmake -B build && cmake --build build --config Release --target llama-server\n');
    console.error('This script does not download for you. A release asset is tens of megabytes, the');
    console.error('URL shape changes between releases, and fetching an executable from a URL this');
    console.error('script guessed is not a thing a build tool should do quietly.');
    process.exit(2);
  }

  const src = resolve(sourcePath);
  if (!existsSync(src)) {
    console.error('No file at ' + src);
    process.exit(2);
  }
  copyFileSync(src, dest);
  try { chmodSync(dest, 0o755); } catch (_e) {}
  console.log('Placed ' + src + '\n     -> ' + dest);
  console.log('\nThis directory is git-ignored. Nothing here is committed.');
  console.log('externalBin stays empty until a binary exists for every target being built.');
}

function main() {
  if (has('list')) return list();
  if (has('check')) return check();
  const triple = arg('triple') || hostTriple();
  place(triple, arg('from'), has('stub'));
  console.log('\nVendored now: ' + (presentTriples().join(', ') || 'nothing'));
  console.log('Next: node scripts/fetch-llama-sidecar.mjs --check');
}

main();
