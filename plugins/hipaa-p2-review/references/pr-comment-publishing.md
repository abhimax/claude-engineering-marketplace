# PR Comment Publishing

Shared posting procedure for the `/hipaa-review` and `/post-hipaa-review` commands. The `hipaa-p2-reviewer` agent never runs this; only the top-level session does, after a human approves.

## Rules

- Post only through `${CLAUDE_PLUGIN_ROOT}/scripts/publish-pr-comment.mts`. Do not use `gh pr comment`, `gh api`, `curl`, or a hand-written request: the script validates the schema, escapes reviewer text, enforces the size limits, and updates only its own marked comment.
- Never edit findings, evidence, or recommendations to make a result pass validation. If the result is invalid, stop and report the validation error.
- Never print, echo, or log a token value. Check presence only, for example `echo "GH_TOKEN=${GH_TOKEN:+set} GITHUB_TOKEN=${GITHUB_TOKEN:+set}"`.
- The script makes one marked top-level PR comment and updates it on reruns. It does not create inline threads, approve, request changes, or merge.

## 1. Render the dry run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-pr-comment.mts" "<result.json>"
```

Exit code non-zero means the result failed schema validation or exceeds a limit; stop and show the `ERROR:` line. Otherwise show the rendered Markdown to the user exactly as printed.

## 2. Approval gate

Posting needs a human decision for this exact rendered comment:

- If `PR_COMMENT_APPROVED` is already `true` in the environment, the surrounding platform has completed its approved human-review gate; continue to step 3.
- Otherwise, ask the user explicitly whether to post the rendered comment to `<owner/repo>#<PR_NUMBER>`, noting that every reader of the PR will see it. Continue only on an unambiguous yes given in this session. Set `PR_COMMENT_APPROVED=true` inline on the post command only after that yes.
- If you cannot ask (non-interactive run) and the variable is not set, do not post. Report the dry-run result path and stop.

## 3. Credentials

The script reads, in order:

| Setting | Source |
|---|---|
| Token | `GH_TOKEN`, else `GITHUB_TOKEN` |
| Repository | `GITHUB_REPOSITORY`, else parsed from a `github.com` `origin` remote |
| PR number | `PR_NUMBER` (required) |
| Comment author | `GH_COMMENT_AUTHOR_LOGIN`, else the token's own login from `GET /user` |
| API base | `GITHUB_API_URL` (optional, HTTPS only) |

If neither token variable is set and the `gh` CLI is authenticated, supply its token inline without printing it: `GH_TOKEN="$(gh auth token)"`. In CI, use the platform's dedicated bot token with fine-grained `Issues: read/write`; a GitHub Actions `GITHUB_TOKEN` cannot read `GET /user`, so also set `GH_COMMENT_AUTHOR_LOGIN` (for example `github-actions[bot]`).

## 4. Post

Run as one Bash call:

```bash
PR_COMMENT_APPROVED=true PR_NUMBER=<n> node "${CLAUDE_PLUGIN_ROOT}/scripts/publish-pr-comment.mts" --post "<result.json>"
```

Prefix `GH_TOKEN="$(gh auth token)"` only when step 3 calls for it. On success the script prints one line such as `GitHub PR comment created on owner/repo#42 with 2 warning(s): <url>`; relay it. On failure, show the `ERROR:` line and stop. Do not retry with a different mechanism.

| Error | Meaning |
|---|---|
| `HTTP 401` / `HTTP 403` | Token missing, expired, or lacking `Issues: read/write` on the repository |
| `HTTP 404` | Wrong repository or PR number, or the token cannot see the repository |
| `Multiple bot-owned review comments found` | Two marked comments by the same author; a human must delete one |
| `GH_COMMENT_AUTHOR_LOGIN` | The token identity could not be read; set the login explicitly |
