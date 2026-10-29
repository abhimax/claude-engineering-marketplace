# Validation Tests

Install the locked development dependencies, type-check the TypeScript, and run the structural-validator and JSON Schema tests from the repository root:

```sh
npm ci
npm run typecheck
npm test
```

The tests exercise catalog uniqueness, source path safety, manifest/catalog name agreement, component frontmatter, review-result schema v2, and the PR-comment publisher using a mocked GitHub API. They do not call GitHub or post a real comment. `fixtures/patient-appointment-synthetic.json` is illustrative synthetic data only; never replace it with real PHI, credentials, or production payloads.

The structural tests do not simulate Claude's reasoning or prove the review agent catches vulnerabilities. The official Claude Code CLI validator checks plugin and marketplace schemas and component metadata; actual reviewer behavior requires human-reviewed evaluations using approved synthetic cases. No AI-based eval or GitHub integration is run by CI.