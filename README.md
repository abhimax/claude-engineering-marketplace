# Claude Engineering Marketplace

A private, version-controlled catalog for reusable Claude Code plugins. The initial `hipaa-p2-review` plugin (display name: Healthcare Privacy and Access Review) provides read-only, report-only PR warnings for six areas: hardcoded secrets/credentials, PHI/PII leakage, apparent production patient data in tests, encryption enforcement, API endpoint access control, and dependency/SCA/BAA context. It complements the existing PR Review Agent; it does not replace it or prove HIPAA compliance. The legacy install ID is retained for compatibility; no severity levels are assigned.

## Architecture

This repository uses Claude Code's native marketplace and plugin layout. The marketplace catalog points to each plugin directory in this repository. Plugin manifests package commands, agents, skills, scripts, and references. No application server, database, PAT, MCP server, or production connection is included. The plugin bundles a dependency-free comment publisher that reads a token from the environment at runtime; it never stores credentials in the repository.

Marketplace packaging/distribution and agent execution/CI integration are separate concerns. See [Integration Contract](#integration-contract).

## Repository Layout

```text
.claude-plugin/marketplace.json
plugins/hipaa-p2-review/
  .claude-plugin/plugin.json
  commands/hipaa-review.md
  commands/post-hipaa-review.md
  agents/hipaa-p2-reviewer.md
  skills/review-healthcare-pr/SKILL.md
  scripts/publish-pr-comment.mts
  references/review-policy.md
  references/finding-format.md
  references/review-result.schema.json
  references/pr-comment-publishing.md
scripts/validate-marketplace
tests/
.github/workflows/validate-marketplace.yml
```

Add future plugins under `plugins/<plugin-name>/` with their own `.claude-plugin/plugin.json`, component directories, references, and README. Then add one unique catalog entry in `.claude-plugin/marketplace.json` whose `source` points to `./plugins/<plugin-name>`. Keep the catalog entry name equal to the plugin manifest name.

## Prerequisites

- Node.js 22.18+ and npm for structural and output-schema tests. The bundled publisher runs with plain `node` on 22.18+ (native TypeScript type stripping).
- Run `npm ci` once to install the locked TypeScript, `tsx`, Node.js type definitions, and Ajv development dependencies.
- Current Claude Code CLI for authoritative plugin/marketplace validation and local installation. The CLI's validator does not require an authenticated review session.
- Git and read access to the private repository for Git-based marketplace distribution.
- For the GitHub Actions secret scan on this organization-owned repository, configure the Gitleaks Action license as the encrypted `GITLEAKS_LICENSE` repository or organization secret. No secret value belongs in this repository.

The official format references are [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces), [Plugins](https://code.claude.com/docs/en/plugins), [Plugin components](https://code.claude.com/docs/en/plugins/components), [Plugin manifest reference](https://code.claude.com/docs/en/plugins/manifest-reference), [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference), and [Skills](https://code.claude.com/docs/en/skills). These were consulted for this implementation; official CLI validation remains the final schema check.

## Local Development

From the repository root:

```sh
npm ci
npm run typecheck
npm test
./scripts/validate-marketplace
```

The shared script runs the TypeScript structural validator followed by the official strict marketplace and plugin validation commands. The tests cover catalog duplicates, source paths, manifest-name agreement, component frontmatter, the finding JSON Schema, and PR-comment rendering/publishing behavior with a mocked GitHub API. They do not prove model behavior or post a real comment.

For a one-session local load without installing:

```sh
claude --plugin-dir ./plugins/hipaa-p2-review
```

The agent is namespaced `hipaa-p2-review:hipaa-p2-reviewer`; the skill is `/hipaa-p2-review:review-healthcare-pr`. Run `/hipaa-p2-review:hipaa-review [pr-number]` to review a PR and, after you approve the rendered report, post it as a PR comment; `/hipaa-p2-review:post-hipaa-review <pr-number>` posts a saved result. The identifier remains unchanged for install compatibility. Use only approved synthetic inputs. Behavior evaluations need human-reviewed synthetic test cases before any deployment gate is considered.

## Add and Install the Local Marketplace

Run both commands from the marketplace repository root. First validate and register the checked-out directory in your local Claude Code settings, then install by the catalog plugin name and marketplace name:

```sh
claude plugin validate . --strict
claude plugin marketplace add .
claude plugin install hipaa-p2-review@claude-engineering-marketplace
```

This local registration is per-user by default and does not publish or sync the marketplace to an organization. To use the local copy after edits, start a new session or run `/reload-plugins`.

## Private Distribution

### Private Git repository

Push this repository to the organization's private GitHub repository. Users need read access and local Git credentials that work without prompts. For GitHub, the documented setup is `gh auth login` followed by `gh auth setup-git`; a PAT is not stored in the marketplace manifest or this project. Users can register the hosted marketplace and install the plugin with:

```sh
claude plugin marketplace add YOUR_ORG/claude-engineering-marketplace
claude plugin install hipaa-p2-review@claude-engineering-marketplace
```

Replace `YOUR_ORG` with the actual GitHub organization. Organization administrators can separately distribute the private GitHub/GitLab repository through Claude organization plugin settings on eligible Team or Enterprise plans; this requires the organization's repository connection and admin approval. Claude Code's local marketplace registration does not configure organization sync, and organization sync does not automatically configure a separate existing agent platform.

For fleet-wide Claude Code installation, an administrator configures `extraKnownMarketplaces` and `enabledPlugins` in approved managed settings. Private git access and managed policy are separate requirements. See [Claude Code organization plugin management](https://code.claude.com/docs/en/plugins/org) and [host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace). Confirm the organization's Claude plan, client surface, repository connection, and policies before selecting a distribution route.

## Versioning and Release

The plugin manifest is the source of its `version`; do not duplicate that value on the marketplace entry. Bump `plugins/hipaa-p2-review/.claude-plugin/plugin.json` for each release so users of a hosted marketplace can receive the updated cached copy. Review and validate the diff, merge it through the organization's approval process, then tag/release according to the organization's GitHub policy. Claude Code also documents `claude plugin tag plugins/hipaa-p2-review --dry-run` for previewing a plugin release tag; use it only after the initial release policy and tag convention are approved.

## Security and Healthcare Data

- Tests and examples must use synthetic patient and appointment data only.
- Never commit PHI, credentials, access tokens, private keys, or production payloads. Gitleaks scans repository history in CI; it does not replace secret management or incident response.
- Do not add a production database connection, API service, GitHub PAT integration, or healthcare-system MCP server without a separately approved design.
- Do not send diffs or review content to another external service without explicit approval.
- Before any PHI is processed, the organization must approve the AI execution environment, data-processing arrangements, retention, logging, and access controls.
- The initial workflow is report-only and requires a human reviewer. CI validates repository/plugin structure; it does not automatically block application merges based on review findings.
- The review aid does not establish HIPAA compliance or replace organizational controls.

## Integration Contract

Packaging and distribution answer where approved plugin instructions live and how an authorized Claude Code environment installs them. Execution and pull-request automation answer how an agent is invoked, what repository context it receives, how output is checked, and who can publish a result. The existing PR Review Agent platform is not assumed to understand or execute Claude Code plugin packages.

Before integration, confirm whether that platform can invoke Claude Code or another approved model runtime, how source code is processed and retained, and what its least-privilege GitHub publication mechanism is. If it cannot load a plugin, an adapter must separately package or translate the reviewed instructions; installing this marketplace alone does not integrate the platform.

Adapter contract: the review agent, the `/hipaa-review` orchestration command, and the comment publisher are implemented here; platform orchestration and secret injection remain the platform owner's responsibility.

- **Input**: pull-request identifier and base/head revisions; changed paths; unified diff; and bounded, relevant surrounding code/configuration needed to validate data flow. The adapter labels all repository content as untrusted, excludes secrets/PHI where possible, and records missing or truncated context.
- **Execution**: use only an organization-approved runtime and model/data-processing arrangement. Invoke this plugin or an explicitly approved equivalent; do not grant production-system access. Keep the existing PR Review Agent independent and preserve its current behavior.
- **Output**: one JSON result following `plugins/hipaa-p2-review/references/review-result.schema.json` (`schema_version` `2.0.0`). Validate JSON and schema before storing or displaying; reject malformed output, preserve `incomplete` status, and redact sensitive material. Findings contain warning, evidence status, category, location, evidence, risk, and recommendation. The contract has no severity field; update connected platform validators before deploying plugin version `0.3.0` or later.
- **Publication**: the platform can pass schema-validated JSON to `node plugins/hipaa-p2-review/scripts/publish-pr-comment.mts --post -` (or `npm run publish:pr-comment -- --post -` in this repository) on stdin with repository and PR metadata. `GH_TOKEN`, `GITHUB_REPOSITORY`, `PR_NUMBER`, and `GH_COMMENT_AUTHOR_LOGIN` come from the platform's secret/config store; never put the PAT in prompts, source files, command-line arguments, logs, or review JSON. Posting requires `PR_COMMENT_APPROVED=true` plus `--post`; set the flag only after the approved human-review step. Otherwise the publisher is dry-run only. It creates or updates one marked issue-level PR comment authored by the configured bot, validates schema before network calls, escapes reviewer text, and never approves, requests changes, or merges. Fine-grained PAT permission: repository `Issues: read/write`; no contents or pull-request review write permission is needed. Use a dedicated bot identity/token.

GitHub notes that create-comment requests trigger notifications and can be secondary-rate-limited. The publisher updates its own marked comment on reruns, avoids touching comments by other authors, and fails closed on ambiguous matches. Platform owners still need to define retries, audit events, retention, and how publication failures are surfaced. Review text may itself reveal sensitive context, so sanitize/redact the validated result and require the approved human gate before posting.

The adapter must define bounded retries and timeouts, fail safely to a visible incomplete/error result, protect logs from PHI and secrets, and record traceable audit events without retaining unnecessary source content. The platform owner must approve these details before processing real pull-request code.

## Known Limitations

- This reviewer does not assign severity levels. Its warnings are limited to the six areas listed above.
- The reviewer agent does not fetch PR diffs or access GitHub; the `/hipaa-review` command collects the diff with git and posts through the publisher only after human approval. The publisher accepts validated review JSON and PR metadata; it never runs the review itself. A separate cloud platform still needs to invoke the publisher with its approved secret injection and human-review gate.
- The comment is a single top-level PR comment; findings are not posted as inline review threads.
- Official CLI validation checks package structure/frontmatter, not the quality or completeness of the model's review.
- Local marketplace installation, GitHub-hosted private access, and Claude organization synchronization are distinct distribution mechanisms.
- No assertion is made that the existing agent platform can execute this plugin.