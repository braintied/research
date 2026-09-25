#!/usr/bin/env bash
# Install or refresh the run-braintied-research skill as a symlink into a
# dedicated worktree pinned to origin/main.
#
# Why a symlink into a pinned worktree: the skill used to be a hand copy under
# ~/.claude/skills that nothing synced. Measured 2026-09-24, it held two fixes
# and ~90 lines of SKILL.md policy the package never had, including the spend
# approval gate. A symlink leaves no second copy to fork. It points at its own
# detached worktree, not ~/Development/stack, because that checkout is shared:
# sessions switch branches in it and it sat 28 commits behind origin/main the
# day this was written. Nobody works in the install worktree; this script is
# the only thing that moves it, and it refuses if anyone edited it.
#
# Run it after anything touching packages/research lands on main. Take the
# script itself from origin/main, not from a checkout, which can be stale:
#   git -C ~/Development/stack fetch -q origin main \
#     && git -C ~/Development/stack show origin/main:packages/research/scripts/install-skill.sh | bash
set -euo pipefail

REPO="${BRAINTIED_STACK_REPO:-$HOME/Development/stack}"
WORKTREE="${BRAINTIED_RESEARCH_INSTALL_WORKTREE:-$HOME/Development/.worktrees/research-main}"
LINK="${BRAINTIED_RESEARCH_SKILL_LINK:-$HOME/.claude/skills/run-braintied-research}"
REF="origin/main"
SKILL_REL="packages/research/skills/run-braintied-research"
TARGET="$WORKTREE/$SKILL_REL"

die() { echo "install-skill: $*" >&2; exit 1; }

[ -d "$REPO/.git" ] || [ -f "$REPO/.git" ] || die "no git repo at $REPO (set BRAINTIED_STACK_REPO)"

git -C "$REPO" fetch --quiet origin main

if [ -e "$WORKTREE" ]; then
  git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1 \
    || die "$WORKTREE exists and is not a git worktree"
  if [ -n "$(git -C "$WORKTREE" status --porcelain --untracked-files=no)" ]; then
    git -C "$WORKTREE" status --short --untracked-files=no >&2
    die "$WORKTREE has local edits. It is an install target, not a workspace: move them to a branch and a PR, then rerun."
  fi
  git -C "$WORKTREE" checkout --quiet --detach "$REF"
else
  git -C "$REPO" worktree add --quiet --detach "$WORKTREE" "$REF"
fi
# Keep worktree reapers off it.
WORKTREE_REAL="$(cd "$WORKTREE" && pwd -P)"
if ! git -C "$REPO" worktree list --porcelain \
  | awk -v wt="worktree $WORKTREE_REAL" '$0 == wt {found=1; next} found && /^locked/ {locked=1} /^$/ {found=0} END {exit !locked}'; then
  git -C "$REPO" worktree lock \
    --reason "install target for $LINK; refresh with packages/research/scripts/install-skill.sh" \
    "$WORKTREE"
fi

# The internal runner needs only package.json; the local fallback runner
# (run-research.mjs) imports dist/, so build the package and its workspace deps.
#
# Use the pnpm the repo pins, not whatever is on PATH. Measured 2026-09-24 on
# the agent laptop: pnpm 8.15.6 on PATH refused the lockfile
# (ERR_PNPM_LOCKFILE_BREAKING_CHANGE) against packageManager pnpm@9.15.9.
PINNED_PNPM="$(sed -n 's/.*"packageManager": *"pnpm@\([^"]*\)".*/\1/p' "$WORKTREE/package.json")"
[ -n "$PINNED_PNPM" ] || die "no pnpm version in $WORKTREE/package.json packageManager"
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm -v 2>/dev/null)" = "$PINNED_PNPM" ]; then
  PNPM=(pnpm)
else
  PNPM=(npx --yes "pnpm@$PINNED_PNPM")
fi
BUILD_LOG="$(mktemp "${TMPDIR:-/tmp}/install-skill.XXXXXX")"
if ! (cd "$WORKTREE" && "${PNPM[@]}" install --frozen-lockfile --prefer-offline \
  && "${PNPM[@]}" --filter "@braintied/research..." run build) >"$BUILD_LOG" 2>&1; then
  tail -30 "$BUILD_LOG" >&2
  die "install/build failed with pnpm $PINNED_PNPM; full log: $BUILD_LOG"
fi
rm -f "$BUILD_LOG"

[ -d "$TARGET" ] || die "no skill at $TARGET"

if [ -L "$LINK" ]; then
  ln -sfn "$TARGET" "$LINK"
elif [ -e "$LINK" ]; then
  # A real directory is a hand copy. Replace it only when it holds nothing the
  # package lacks; otherwise the refresh would delete unlanded work.
  if ! diff -rq "$TARGET" "$LINK" >&2; then
    die "$LINK is a copy that differs from $REF (above). Upstream what only the copy holds, then rerun."
  fi
  rm -rf "$LINK"
  ln -s "$TARGET" "$LINK"
else
  mkdir -p "$(dirname "$LINK")"
  ln -s "$TARGET" "$LINK"
fi

echo "install-skill: $LINK -> $TARGET @ $(git -C "$WORKTREE" rev-parse --short HEAD)"
