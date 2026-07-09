#!/usr/bin/env bash
# ============================================================
# DATAGLOW — new-agent-worktree
# ============================================================
# Stage 1 ("Isolate") of the Build Nervous System (docs/build-nervous-system.md).
#
# Creates a dedicated git worktree for a single coding-agent session: a separate
# working directory that shares this repo's .git object store. Each session gets
# its own checked-out branch so two sessions can never scribble over each other's
# working tree, while still sharing objects (cheap, no re-clone).
#
# Usage:   scripts/new-agent-worktree.sh <branch-name>
# Example: scripts/new-agent-worktree.sh feat/my-change
#
# Result:  ../dataglow-worktrees/<branch-name>  on a fresh branch <branch-name>.
#
# This is additive and low-risk: it only calls `git worktree add`. It does not
# change how existing infra provisions clones, and it never touches `main`.

set -euo pipefail

branch="${1:-}"
if [ -z "$branch" ]; then
  echo "usage: $0 <branch-name>" >&2
  echo "  e.g. $0 feat/my-change" >&2
  exit 2
fi

# Resolve the repo root so the worktree lands in a sibling directory regardless
# of the current working directory.
repo_root="$(git rev-parse --show-toplevel)"
parent_dir="$(dirname "$repo_root")"
worktrees_dir="$parent_dir/dataglow-worktrees"
target="$worktrees_dir/$branch"

if [ -e "$target" ]; then
  echo "error: worktree path already exists: $target" >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$branch"; then
  echo "error: branch already exists: $branch (pick a new name or check it out directly)" >&2
  exit 1
fi

mkdir -p "$worktrees_dir"

# Base the new branch on the current HEAD of this checkout. Callers that want it
# based on an up-to-date main should `git fetch` and check out main first.
git worktree add "$target" -b "$branch"

echo ""
echo "worktree ready:"
echo "  path:   $target"
echo "  branch: $branch"
echo ""
echo "next:  cd \"$target\""
echo "clean up when done:  git worktree remove \"$target\""
