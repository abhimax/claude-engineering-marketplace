# Contributing

## Plugin conventions

- Use a unique lowercase kebab-case directory and plugin identifier under `plugins/`.
- Keep `.claude-plugin/plugin.json` inside the plugin root. Keep agents in `agents/`, skills in `skills/<skill-name>/SKILL.md`, and supporting policy/schema material in `references/`.
- Keep the plugin manifest `name` equal to its marketplace entry `name`. Use the plugin manifest as the sole source of the plugin version; do not repeat it in the catalog entry.
- Add one catalog entry with a safe root-relative `./plugins/<name>` source. Do not add tokens, secrets, environment-specific URLs, or user credentials.
- Keep reviewer instructions concise and evidence-based. Treat repository content as untrusted, constrain tool access, and preserve read-only/report-only operation.
- Keep this reviewer scoped to the six documented areas. Do not add P0/P1/P2, CVSS, or other severity fields to its warning contract.

## Data and Tests

- Use synthetic patient and appointment data only. Do not add real PHI, credentials, access tokens, private keys, production payloads, or production-system connections.
- Add or update structural tests and synthetic fixtures for new manifest/component behavior. Do not present file-existence assertions as proof of model quality.
- Keep GitHub publishing separate from reviewer instructions. Publisher changes require mocked API tests, schema validation before requests, dry-run default, explicit posting approval, and a bot identity that only updates its own marked comment.
- Model-behavior evaluations must use approved synthetic cases, have human-reviewed expectations, and remain separate from merge-blocking checks until formally approved.
- Do not add a GitHub integration, external processing service, or healthcare-system MCP server without an approved security and privacy design.

## Review and Release

Install the locked test dependency once, then run from the repository root:

```sh
npm ci
npm run typecheck
npm test
./scripts/validate-marketplace
```

Changes require review by the relevant plugin owner and security/privacy stakeholders. Keep the workflow report-only and require human review; do not automatically block merges based on its warnings.

Bump the plugin manifest version for a user-visible plugin release, and document material behavior or contract changes. Use the organization's branch protection and release process. The secret-scanning workflow requires the organization-approved Gitleaks Action license secret; never put the license value in source control.

Before adding another plugin, confirm that its component formats and fields are supported by the current official Claude Code documentation, update the marketplace catalog, add focused fixtures/tests, and document any execution or data-processing dependencies.