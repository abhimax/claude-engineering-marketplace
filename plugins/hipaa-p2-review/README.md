# Healthcare Privacy and Access Review Plugin

This Claude Code plugin packages a read-only healthcare PR review agent and the `review-healthcare-pr` skill. The reviewer produces warnings for six areas and does not itself access GitHub. A separate publisher can post a validated result to a PR after explicit human approval. The plugin complements the existing PR Review Agent and does not prove HIPAA compliance. The legacy plugin/install ID remains `hipaa-p2-review`; no severity is assigned.

## Contents

- `agents/hipaa-p2-reviewer.md`: constrained read-only agent.
- `skills/review-healthcare-pr/SKILL.md`: review workflow.
- `references/review-policy.md`: the six-area review scope and evidence boundaries.
- `references/finding-format.md` and `references/review-result.schema.json`: JSON output contract.

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

## Optional GitHub PR Comment Publisher

The reviewer itself remains read-only. The surrounding platform may pass its schema-validated result to the repository's separate publisher:

```sh
npm run publish:pr-comment -- review-result.json
```

Without `--post`, it validates the result and renders a dry-run comment locally. To publish, feed the JSON on stdin or from a file and use `--post`; the platform must also set `PR_COMMENT_APPROVED=true` only after its approved human-review gate. Example: `cat review-result.json | npm run publish:pr-comment -- --post -`. The publisher requires `GH_TOKEN`, `GITHUB_REPOSITORY=owner/repo`, `PR_NUMBER`, and `GH_COMMENT_AUTHOR_LOGIN`, supplied by the platform secret/config store. Never pass the PAT as a CLI argument or include it in prompts/logs.

Use a dedicated bot token with the least privilege needed: fine-grained repository `Issues: read/write` for listing, creating, and updating PR issue comments. Configure `GH_COMMENT_AUTHOR_LOGIN` to that bot login; only a marked comment by that account is eligible for update. The publisher only creates or updates its own marked top-level PR comment; it does not create inline review threads, approve/request changes, merge, or modify source. It validates schema version 2.0.0 before making requests, limits input to 2 MB and the rendered comment to 60,000 characters, and defaults to no network writes.

Before enabling posting, confirm platform secret injection, human approval semantics, audit/retention, failure/retry handling, and that comment content is redacted of PHI and credentials. A PAT-enabled comment can expose review content to PR readers; do not enable unattended posting until those controls are approved.