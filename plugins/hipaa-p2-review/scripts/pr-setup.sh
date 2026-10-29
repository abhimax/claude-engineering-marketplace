#!/usr/bin/env bash
# pr-setup.sh — check out the PR head and write the review input for /hipaa-review.
#
# A real script rather than Markdown steps: headless runners (for example the Xianix Executor)
# clone the default branch, and improvised checkout/diff commands leave HEAD there.
#
# Usage:
#   PR_NUMBER=42 bash pr-setup.sh   # review PR #42
#   bash pr-setup.sh                # PR for the current branch if gh finds one, else local branch vs default
#
# Outputs (in /tmp/hipaa-p2-review/):
#   state.env          MODE (pr|local), PR_NUMBER, BASE_REF, HEAD_SHA, REPOSITORY
#   pr.diff            unified diff of merge-base(origin/BASE_REF)..HEAD
#   changed-files.txt  name-status list for the same range

set -euo pipefail

OUT=/tmp/hipaa-p2-review
mkdir -p "$OUT"
# Clear run-scoped files so a reused container never posts a previous run's result.
rm -f "$OUT/state.env" "$OUT/pr.diff" "$OUT/changed-files.txt" "$OUT/review-result.json"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "ERROR: not inside a git repository" >&2; exit 1; }

PR_NUMBER="${PR_NUMBER:-}"
if [ -z "$PR_NUMBER" ] && command -v gh >/dev/null 2>&1; then
  PR_NUMBER=$(gh pr view --json number --jq '.number' 2>/dev/null || true)
fi

if [ -n "$PR_NUMBER" ]; then
  case "$PR_NUMBER" in
    *[!0-9]*|0) echo "ERROR: PR_NUMBER must be a positive integer" >&2; exit 1 ;;
  esac
  command -v gh >/dev/null 2>&1 || { echo "ERROR: gh CLI is required to resolve PR #${PR_NUMBER}" >&2; exit 1; }
  PR_META=$(gh pr view "$PR_NUMBER" --json baseRefName,headRefOid,state --jq '"\(.baseRefName) \(.headRefOid) \(.state)"') || {
    echo "ERROR: could not read PR #${PR_NUMBER} with gh (check GITHUB_TOKEN / GH_TOKEN and repository access)" >&2
    exit 1
  }
  read -r BASE_REF EXPECTED_HEAD PR_STATE <<<"$PR_META"
  [ "$PR_STATE" = "OPEN" ] || { echo "ERROR: PR #${PR_NUMBER} is ${PR_STATE}, not open" >&2; exit 1; }

  if [ "$(git rev-parse HEAD)" != "$EXPECTED_HEAD" ]; then
    if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
      echo "ERROR: uncommitted changes in the working tree; commit or stash them before checking out PR #${PR_NUMBER}" >&2
      exit 1
    fi
    git fetch --quiet origin "refs/pull/${PR_NUMBER}/head"
    git checkout --quiet --detach FETCH_HEAD
  fi
  [ "$(git rev-parse HEAD)" = "$EXPECTED_HEAD" ] || {
    echo "ERROR: checked-out HEAD does not match PR #${PR_NUMBER} head ${EXPECTED_HEAD}; the PR may have been updated during setup" >&2
    exit 1
  }
  MODE=pr
else
  BASE_REF=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
  BASE_REF="${BASE_REF:-main}"
  PR_NUMBER=""
  MODE=local
fi

# Shallow clones have no merge base; deepen before diffing.
if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  git fetch --quiet --unshallow origin || true
fi
git fetch --quiet origin "+refs/heads/${BASE_REF}:refs/remotes/origin/${BASE_REF}"

git diff "origin/${BASE_REF}...HEAD" > "$OUT/pr.diff"
git diff --name-status "origin/${BASE_REF}...HEAD" > "$OUT/changed-files.txt"

REMOTE=$(git remote get-url origin 2>/dev/null | sed -E 's|https?://[^@/]+@|https://|' || true)
REPOSITORY=$(printf '%s' "$REMOTE" | sed -E 's#^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)##; s#\.git$##; s#/$##')
HEAD_SHA=$(git rev-parse HEAD)

{
  printf 'export MODE=%q\n' "$MODE"
  printf 'export PR_NUMBER=%q\n' "$PR_NUMBER"
  printf 'export BASE_REF=%q\n' "$BASE_REF"
  printf 'export HEAD_SHA=%q\n' "$HEAD_SHA"
  printf 'export REPOSITORY=%q\n' "$REPOSITORY"
} > "$OUT/state.env"

echo "MODE=${MODE} PR_NUMBER=${PR_NUMBER:-none} BASE_REF=${BASE_REF} HEAD_SHA=${HEAD_SHA} REPOSITORY=${REPOSITORY}"
echo "DIFF_BYTES=$(wc -c < "$OUT/pr.diff" | tr -d ' ') CHANGED_FILES=$(wc -l < "$OUT/changed-files.txt" | tr -d ' ')"
