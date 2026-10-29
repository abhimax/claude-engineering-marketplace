# Healthcare Privacy and Access Review Plugin

This Claude Code plugin packages a read-only healthcare PR review agent and the `review-healthcare-pr` skill. It produces report-only warnings for the six areas below, complements the existing PR Review Agent, and does not prove HIPAA compliance. The legacy plugin/install ID remains `hipaa-p2-review`; no P0/P1/P2 or other severity is assigned.

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

Use only synthetic data when exercising the reviewer. Do not pass real PHI, production payloads, credentials, or source diffs to an unapproved AI execution environment. Human review is required; the plugin does not post comments or block merges.

The review areas are hardcoded secrets/credentials, PHI/PII leakage, apparent production patient data in tests, encryption enforcement, endpoint access control, and dependency/SCA/BAA context. SCA findings and BAA status must be supplied or verified from approved sources; the reviewer must not invent CVEs or vendor status. Encryption review must account for managed encryption controls, not require a literal algorithm name in application code.

Use only synthetic data when exercising the reviewer. Do not pass real PHI, production payloads, credentials, or source diffs to an unapproved AI execution environment. Human review is required; the plugin does not post comments or block merges.

The organization must approve the AI execution environment, data-processing arrangements, retention, logging, and access controls before PHI is processed. No healthcare-system MCP server or production integration is configured here.