# HIPAA/P2 Review Plugin

This Claude Code plugin packages a read-only healthcare backend review agent and the `review-healthcare-pr` skill. It is an automated review aid, complements the existing PR Review Agent, and does not prove HIPAA compliance.

## Contents

- `agents/hipaa-p2-reviewer.md`: constrained read-only agent.
- `skills/review-healthcare-pr/SKILL.md`: review workflow.
- `references/review-policy.md`: review scope and the unapproved P2-policy placeholder.
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

The organization must approve the AI execution environment, data-processing arrangements, retention, logging, and access controls before PHI is processed. No healthcare-system MCP server or production integration is configured here.