# Healthcare Privacy and Access Review Plugin

This Claude Code plugin packages a read-only healthcare PR review agent, the `review-healthcare-pr` skill, and a `/hipaa-review` command that runs the review and posts the report as a PR comment after explicit human approval. The reviewer agent produces warnings for six areas and never accesses GitHub itself; posting is done by a bundled, dependency-free publisher script. The plugin complements the existing PR Review Agent and does not prove HIPAA compliance. The legacy plugin/install ID remains `hipaa-p2-review`; no severity is assigned.

## Contents

- `commands/hipaa-review.md`: `/hipaa-p2-review:hipaa-review [pr-number] [sca-report...]` collects the PR diff, runs the reviewer, validates the result, shows a dry run, and posts after approval.
- `commands/post-hipaa-review.md`: `/hipaa-p2-review:post-hipaa-review <pr-number> [result.json]` posts a saved result (user-invoked only).
- `agents/hipaa-p2-reviewer.md`: constrained read-only agent.
- `skills/review-healthcare-pr/SKILL.md`: review workflow.
- `scripts/publish-pr-comment.mts`: schema-validating PR comment publisher (Node.js 22.18+, no dependencies).
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

`/hipaa-review` follows the same split as the pr-reviewer plugin: the top-level session orchestrates, the review sub-agent analyses, and a real script posts. Concretely, it:

1. Resolves the PR (argument or `gh pr view` for the current branch), confirms the checkout matches the PR head, and writes the merge-base diff to `/tmp/hipaa-p2-review/`.
2. Spawns `hipaa-p2-review:hipaa-p2-reviewer` with the diff paths and any SCA reports, and saves its JSON to `/tmp/hipaa-p2-review/review-result.json`.
3. Validates the JSON and renders the comment locally (dry run).
4. Asks the user to approve posting that exact comment, unless the platform already set `PR_COMMENT_APPROVED=true`. Non-interactive runs without that flag do not post.
5. Creates, or on reruns updates, one marked top-level PR comment.

The publisher can also run on its own:

```sh
node plugins/hipaa-p2-review/scripts/publish-pr-comment.mts review-result.json        # dry run
PR_COMMENT_APPROVED=true PR_NUMBER=42 node plugins/hipaa-p2-review/scripts/publish-pr-comment.mts --post review-result.json
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
