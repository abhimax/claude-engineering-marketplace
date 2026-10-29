# Healthcare Privacy and Access Review Plugin

This Claude Code plugin packages a read-only healthcare PR review agent, the `review-healthcare-pr` skill, and a `/hipaa-review` command that runs the review and posts the report as a PR comment after explicit human approval. The reviewer agent produces warnings for six areas and never accesses GitHub itself; posting is done by a bundled, dependency-free publisher script. The plugin complements the existing PR Review Agent and does not prove HIPAA compliance. The legacy plugin/install ID remains `hipaa-p2-review`; no severity is assigned.

## Contents

- `skills/review-healthcare-pr/SKILL.md`: `/hipaa-p2-review:review-healthcare-pr [pr-number] [--approved] [sca-report...]` collects the PR diff, runs the reviewer, validates the result, shows a dry run, and posts after approval.
- `commands/hipaa-review.md`: `/hipaa-p2-review:hipaa-review`, an alias for the skill.
- `commands/post-hipaa-review.md`: `/hipaa-p2-review:post-hipaa-review <pr-number> [result.json]` posts a saved result (user-invoked only).
- `agents/hipaa-p2-reviewer.md`: constrained read-only agent.
- `references/review-procedure.md`: the reviewer agent's six-area review steps.
- `scripts/publish-pr-comment.mjs`: schema-validating PR comment publisher (Node.js 18+, no dependencies).
- `references/review-policy.md`: the six-area review scope and evidence boundaries.
- `references/finding-format.md` and `references/review-result.schema.json`: JSON output contract.
- `references/pr-comment-publishing.md`: the posting procedure both commands follow.

## Local test

From the marketplace repository root, validate this plugin with:

```sh
claude plugin validate ./plugins/hipaa-p2-review --strict
```

Load the plugin for one local Claude Code session without installing it:

```sh
claude --plugin-dir ./plugins/hipaa-p2-review
```

The review areas are hardcoded secrets/credentials, PHI/PII leakage, apparent production patient data in tests, encryption enforcement, endpoint access control, and dependency/SCA/BAA context. SCA findings and BAA status must be supplied or verified from approved sources; the reviewer must not invent CVEs or vendor status. Encryption review must account for managed encryption controls, not require a literal algorithm name in application code.

Use only synthetic data when exercising the reviewer. Do not pass real PHI, production payloads, credentials, or source diffs to an unapproved AI execution environment. Human review is required; the reviewer itself does not post comments or block merges.

The organization must approve the AI execution environment, data-processing arrangements, retention, logging, and access controls before PHI is processed. No healthcare-system MCP server or production integration is configured here.

## Commenting on the PR

`/hipaa-p2-review:review-healthcare-pr` (or its alias `/hipaa-p2-review:hipaa-review`) follows the same split as the pr-reviewer plugin: the top-level session orchestrates, the review sub-agent analyses, and a real script posts. Concretely, it:

1. Finds the plugin root (on headless runners `CLAUDE_PLUGIN_ROOT` is often unset in Bash) and checks that `node` 18+ is available.
2. Runs `scripts/pr-setup.sh`: resolves the PR, checks out its head (detached) if the runner cloned another branch, fetches the base, and writes the diff to `/tmp/hipaa-p2-review/`.
3. Spawns `hipaa-p2-review:hipaa-p2-reviewer` with the diff paths, reference paths, and any SCA reports, and saves its JSON to `/tmp/hipaa-p2-review/review-result.json`.
4. Validates the JSON and renders the comment locally (dry run).
5. Posts only when approved: `PR_COMMENT_APPROVED=true` from the platform, `--approved` in the invocation, the `ai-dlc/pr/hipaa-p2-review` label on the PR (checked on GitHub by the publisher), or an explicit yes in an interactive session. Otherwise it stops at the dry run.
6. Creates, or on reruns updates, one marked top-level PR comment.

### Automated trigger (Xianix / AI-DLC agent)

Add this execution block to the agent's `rules.json`. Applying the `ai-dlc/pr/hipaa-p2-review` label is the human opt-in; the publisher verifies the label on the PR before posting, so `--approved` is optional. Only people who are allowed to publish review content on the PR should be able to apply the label.

```json
{
  "name": "github-pull-request-hipaa-p2-review",
  "platform": "github",
  "repository": { "url": "repository.clone_url" },
  "match-any": [
    { "name": "github-pr-tag-applied", "rule": "action==labeled&&label.name=='ai-dlc/pr/hipaa-p2-review'&&pull_request.state=='open'" },
    { "name": "github-pr-opened-with-tag", "rule": "action==opened&&pull_request.labels.*.name=='ai-dlc/pr/hipaa-p2-review'&&pull_request.state=='open'" },
    { "name": "github-pr-synchronize-with-tag", "rule": "action==synchronize&&pull_request.labels.*.name=='ai-dlc/pr/hipaa-p2-review'&&pull_request.state=='open'" },
    { "name": "github-pr-reopened-with-tag", "rule": "action==reopened&&pull_request.labels.*.name=='ai-dlc/pr/hipaa-p2-review'&&pull_request.state=='open'" }
  ],
  "use-inputs": [
    { "name": "pr-number", "value": "pull_request.number", "mandatory": true }
  ],
  "use-plugins": [
    { "plugin-name": "hipaa-p2-review@claude-engineering-marketplace", "marketplace": "abhimax/claude-engineering-marketplace" }
  ],
  "with-envs": [
    { "name": "GITHUB-TOKEN", "value": "secrets.GITHUB-TOKEN", "mandatory": true }
  ],
  "conversation-key": "pull_request.number",
  "model": "claude-sonnet-4-5",
  "max-budget-usd": 3,
  "execute-prompt": "You are reviewing pull request #{{pr-number}} in the repository {{repository-name}}. Run /hipaa-p2-review:hipaa-review {{pr-number}} --approved to perform the healthcare privacy and access review and post its report as a PR comment."
}
```

The `execute-prompt` may invoke either `/hipaa-p2-review:review-healthcare-pr {{pr-number}}` or `/hipaa-p2-review:hipaa-review {{pr-number}}`; both run the full flow and post. The `GITHUB-TOKEN` secret is re-exported as `GITHUB_TOKEN`, which both `gh` and the publisher read, and it needs `Issues: read/write` (plus read access to pull requests and contents). The comment is authored by the token's account. The `reopened` rule is optional; without it, closing and reopening a PR does not trigger a review. To re-run a review, remove and re-apply the label or push a commit.

The publisher can also run on its own:

```sh
node plugins/hipaa-p2-review/scripts/publish-pr-comment.mjs review-result.json        # dry run
PR_COMMENT_APPROVED=true PR_NUMBER=42 node plugins/hipaa-p2-review/scripts/publish-pr-comment.mjs --post review-result.json
```

From the marketplace repository, `npm run publish:pr-comment -- ...` runs the same file. Without `--post`, it validates and renders locally and makes no network request. Posting also requires `PR_COMMENT_APPROVED=true`, set only after a human approves.

| Setting | Source |
|---|---|
| Token | `GH_TOKEN`, else `GITHUB_TOKEN` (interactive users can supply `GH_TOKEN="$(gh auth token)"`) |
| Repository | `GITHUB_REPOSITORY`, else a `github.com` `origin` remote |
| PR number | `PR_NUMBER` |
| Comment author | `GH_COMMENT_AUTHOR_LOGIN`, else the token's login from `GET /user` |
| API base | `GITHUB_API_URL` (optional, HTTPS only) |

Never pass a token as a CLI argument or include it in prompts/logs. For platform use, use a dedicated bot token with the least privilege needed: fine-grained repository `Issues: read/write`, and set `GH_COMMENT_AUTHOR_LOGIN` to that bot login. Only a marked comment by that account is eligible for update. The publisher does not create inline review threads, approve/request changes, merge, or modify source. It validates schema version 2.0.0 before making requests, limits input to 2 MB and the rendered comment to 60,000 characters, and fails closed on ambiguous matches.

Before enabling posting in a shared platform, confirm secret injection, human approval semantics, audit/retention, failure/retry handling, and that comment content is redacted of PHI and credentials. A posted comment exposes review content to every PR reader; do not enable unattended posting until those controls are approved.
