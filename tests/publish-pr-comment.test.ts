import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import {
  assertPostApproval,
  parseReviewResult,
  publishReviewComment,
  renderReviewComment,
  repositoryFromRemote,
  resolvePostApproval,
  resolvePublisherConfig,
  validatePublisherConfig,
  type PublisherConfig
} from '../plugins/hipaa-p2-review/scripts/publish-pr-comment.mjs';

const sampleReview = parseReviewResult({
  schema_version: '2.0.0',
  review_status: 'complete',
  summary: 'One potential exposure needs human verification.',
  findings: [{
    id: 'HPR-001',
    alert: 'warning',
    category: 'phi_pii_leakage',
    evidence_status: 'potential',
    confidence: 'medium',
    title: 'Patient detail may be written to a log',
    location: { path: 'src/patient/log.ts', start_line: 20, end_line: 21 },
    evidence: 'A changed log statement includes a health-data object.',
    risk: 'Log readers may gain access to patient health information.',
    recommendation: 'Remove the health-data object from the log payload.',
    human_verification_required: true
  }],
  uncertainties: ['Confirm the production logging access policy.']
});

const baseConfig: PublisherConfig = {
  token: 'synthetic-test-token',
  repository: 'example/healthcare-api',
  pullRequestNumber: 42,
  expectedAuthor: 'healthcare-review-bot'
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

test('renders warning fields and escapes reviewer-controlled markdown/HTML', () => {
  const review = parseReviewResult({
    ...sampleReview,
    summary: '<script>alert(1)</script> | summary'
  });
  const body = renderReviewComment(review);
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt; \\| summary'));
  assert.doesNotMatch(body, /<script>|@everyone/);
  assert.match(body, /\*\*⚠️ Risk\*\*/);
  assert.match(body, /\*\*✅ Recommendation\*\*/);
  assert.ok(body.startsWith('<!-- healthcare-data-review -->'));
  assert.doesNotMatch(body, /\*\*Severity:\*\*|\bP[012]\b/);
});

test('rejects review JSON that is outside schema version 2', () => {
  assert.throws(() => parseReviewResult({ schema_version: '1.0.0' }), /failed schema validation/);
});

test('requires explicit human approval before enabling comment posting', () => {
  assert.throws(() => assertPostApproval(undefined), /PR_COMMENT_APPROVED=true/);
  assert.throws(() => assertPostApproval('false'), /PR_COMMENT_APPROVED=true/);
  assert.doesNotThrow(() => assertPostApproval('true'));
});

test('rejects rendered comments above the configured size limit', () => {
  const review = parseReviewResult({
    ...sampleReview,
    summary: 'x'.repeat(60_001)
  });
  assert.throws(() => renderReviewComment(review), /exceeds the 60000-character limit/);
});

test('requires a valid repository, PR number, token, author, and HTTPS API URL', () => {
  assert.throws(() => validatePublisherConfig({ ...baseConfig, repository: 'not-a-repository' }), /owner\/repository/);
  assert.throws(() => validatePublisherConfig({ ...baseConfig, pullRequestNumber: 0 }), /positive integer/);
  assert.throws(() => validatePublisherConfig({ ...baseConfig, token: '' }), /token is required/);
  assert.throws(() => validatePublisherConfig({ ...baseConfig, apiUrl: 'http://api.github.com' }), /must be HTTPS/);
});

test('creates a comment on the PR issue endpoint when none exists', async () => {
  const calls: Array<{ url: string; method: string; headers: Headers; body?: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: request.method === 'POST' ? await request.text() : undefined
    });
    if (request.url.endsWith('/issues/42/comments?per_page=100&page=1')) return jsonResponse([]);
    if (request.url.endsWith('/issues/42/comments') && request.method === 'POST') {
      return jsonResponse({ html_url: 'https://github.com/example/healthcare-api/pull/42#issuecomment-1' }, 201);
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  const result = await publishReviewComment(sampleReview, baseConfig, fakeFetch);
  assert.deepEqual(result, {
    action: 'created',
    url: 'https://github.com/example/healthcare-api/pull/42#issuecomment-1'
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.headers.get('authorization') === 'Bearer synthetic-test-token'));
  assert.ok(calls.some((call) => call.method === 'POST' && call.body?.includes('Healthcare Privacy and Access Review')));
});

test('updates the existing marked comment only when authored by configured bot', async () => {
  const calls: Array<{ method: string; url: string }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push({ method: request.method, url: request.url });
    if (request.url.endsWith('/issues/42/comments?per_page=100&page=1')) {
      return jsonResponse([{
        id: 501,
        body: '<!-- healthcare-data-review --> old report',
        user: { login: 'healthcare-review-bot' }
      }]);
    }
    if (request.url.endsWith('/issues/comments/501') && request.method === 'PATCH') {
      return jsonResponse({ html_url: 'https://github.com/example/healthcare-api/pull/42#issuecomment-501' });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  const result = await publishReviewComment(sampleReview, baseConfig, fakeFetch);
  assert.equal(result.action, 'updated');
  assert.ok(calls.some((call) => call.method === 'PATCH'));
  assert.ok(!calls.some((call) => call.method === 'POST'));
});

test('does not modify another author comment that contains the marker', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.method);
    if (request.url.endsWith('/issues/42/comments?per_page=100&page=1')) {
      return jsonResponse([{
        id: 502,
        body: '<!-- healthcare-data-review --> unrelated',
        user: { login: 'another-user' }
      }]);
    }
    if (request.url.endsWith('/issues/42/comments') && request.method === 'POST') return jsonResponse({ id: 503 }, 201);
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  const result = await publishReviewComment(sampleReview, baseConfig, fakeFetch);
  assert.equal(result.action, 'created');
  assert.ok(calls.includes('POST'));
  assert.ok(!calls.includes('PATCH'));
});

test('built-in schema validation agrees with Ajv for valid and mutated results', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../plugins/hipaa-p2-review/references/review-result.schema.json', import.meta.url), 'utf8')) as AnySchema;
  const ajvValidate = new Ajv2020({ allErrors: true }).compile(schema);
  const finding = sampleReview.findings[0];
  const candidates: unknown[] = [
    sampleReview,
    { ...sampleReview, findings: [] },
    { ...sampleReview, review_status: 'incomplete' },
    { ...sampleReview, schema_version: '1.0.0' },
    { ...sampleReview, review_status: 'done' },
    { ...sampleReview, summary: '' },
    { ...sampleReview, extra: true },
    { ...sampleReview, uncertainties: [1] },
    { ...sampleReview, findings: [{ ...finding, id: 'HPR-1' }] },
    { ...sampleReview, findings: [{ ...finding, alert: 'error' }] },
    { ...sampleReview, findings: [{ ...finding, category: 'generic_security' }] },
    { ...sampleReview, findings: [{ ...finding, confidence: 'certain' }] },
    { ...sampleReview, findings: [{ ...finding, severity: 'P2' }] },
    { ...sampleReview, findings: [{ ...finding, human_verification_required: 'yes' }] },
    { ...sampleReview, findings: [{ ...finding, location: { ...finding.location, start_line: 0 } }] },
    { ...sampleReview, findings: [{ ...finding, location: { ...finding.location, end_line: 1.5 } }] },
    { ...sampleReview, findings: [{ ...finding, location: { path: 'a.ts', start_line: 1 } }] },
    { ...sampleReview, findings: [{ ...finding, location: { ...finding.location, column: 3 } }] },
    { ...sampleReview, findings: ['not-an-object'] },
    [],
    null
  ];
  for (const candidate of candidates) {
    const expected = ajvValidate(candidate);
    let actual = true;
    try {
      parseReviewResult(candidate);
    } catch {
      actual = false;
    }
    assert.equal(actual, expected, JSON.stringify(candidate));
  }
});

test('derives owner/repository only from github.com remotes and strips credentials', () => {
  assert.equal(repositoryFromRemote('https://github.com/example/healthcare-api.git\n'), 'example/healthcare-api');
  assert.equal(repositoryFromRemote('git@github.com:example/healthcare-api.git'), 'example/healthcare-api');
  assert.equal(repositoryFromRemote('ssh://git@github.com/example/healthcare-api'), 'example/healthcare-api');
  assert.equal(repositoryFromRemote('https://x-access-token:synthetic@github.com/example/healthcare-api.git'), 'example/healthcare-api');
  assert.equal(repositoryFromRemote('https://dev.azure.com/org/project/_git/repo'), undefined);
  assert.equal(repositoryFromRemote(''), undefined);
});

test('resolves missing repository and comment author without overriding explicit config', async () => {
  const requested: string[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requested.push(`${request.method} ${request.url}`);
    if (request.url === 'https://api.github.com/user') return jsonResponse({ login: 'healthcare-review-bot' });
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  const resolved = await resolvePublisherConfig(
    { GITHUB_TOKEN: 'synthetic-test-token', PR_NUMBER: '42' },
    fakeFetch,
    () => 'git@github.com:example/healthcare-api.git'
  );
  assert.deepEqual(resolved, { ...baseConfig });
  assert.deepEqual(requested, ['GET https://api.github.com/user']);

  const explicit = await resolvePublisherConfig({
    GH_TOKEN: 'synthetic-test-token',
    GITHUB_REPOSITORY: 'example/other-repo',
    PR_NUMBER: '7',
    GH_COMMENT_AUTHOR_LOGIN: 'configured-bot'
  }, fakeFetch, () => 'git@github.com:example/healthcare-api.git');
  assert.equal(explicit.repository, 'example/other-repo');
  assert.equal(explicit.expectedAuthor, 'configured-bot');
  assert.equal(requested.length, 1);
});

test('fails closed when repository or author identity cannot be resolved', async () => {
  const failingFetch: typeof fetch = async () => jsonResponse({ message: 'Resource not accessible' }, 403);
  await assert.rejects(
    resolvePublisherConfig({ GH_TOKEN: 'synthetic-test-token', PR_NUMBER: '42' }, failingFetch, () => 'https://gitlab.com/example/repo.git'),
    /GITHUB_REPOSITORY=owner\/repo/
  );
  await assert.rejects(
    resolvePublisherConfig({ GH_TOKEN: 'synthetic-test-token', PR_NUMBER: '42', GITHUB_REPOSITORY: 'example/healthcare-api' }, failingFetch),
    /GH_COMMENT_AUTHOR_LOGIN/
  );
  await assert.rejects(
    resolvePublisherConfig({ PR_NUMBER: '42', GITHUB_REPOSITORY: 'example/healthcare-api' }, failingFetch),
    /token is required/
  );
});

test('approves posting from the environment or the PR opt-in label, and refuses otherwise', async () => {
  const requested: string[] = [];
  const labelsFetch = (names: string[]): typeof fetch => async (input, init) => {
    const request = new Request(input, init);
    requested.push(request.url);
    if (request.url.endsWith('/issues/42/labels?per_page=100')) return jsonResponse(names.map((name) => ({ name })));
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };

  assert.equal(await resolvePostApproval({ PR_COMMENT_APPROVED: 'true' }, baseConfig, labelsFetch([])), 'environment');
  assert.equal(requested.length, 0);
  assert.equal(await resolvePostApproval({}, baseConfig, labelsFetch(['ai-dlc/pr/hipaa-p2-review'])), 'label');
  assert.equal(await resolvePostApproval({ HIPAA_REVIEW_APPROVAL_LABEL: 'custom/opt-in' }, baseConfig, labelsFetch(['custom/opt-in'])), 'label');
  await assert.rejects(resolvePostApproval({}, baseConfig, labelsFetch(['ai-dlc/pr/pr-review'])), /PR_COMMENT_APPROVED=true.*'ai-dlc\/pr\/hipaa-p2-review' label/);
  await assert.rejects(resolvePostApproval({ PR_COMMENT_APPROVED: 'false' }, baseConfig, labelsFetch([])), /label/);
});

test('renders status, coverage for all six areas, and keeps blocks separated', () => {
  const body = renderReviewComment(sampleReview);
  assert.match(body, /\| \*\*Review status\*\* \| ✅ Complete \|/);
  assert.match(body, /⚠️ 1 — 🔴 0 confirmed · 🟡 1 potential/);
  assert.match(body, /\| 🩺 PHI\/PII leakage \| ⚠️ 1 warning \|/);
  assert.match(body, /\| 🔑 Hardcoded secrets & credentials \| ✅ No warnings \|/);
  assert.equal((body.match(/^\| (🔑|🩺|🧪|🔒|🛡️|📦) /gmu) ?? []).length, 6);
  assert.match(body, /> \[!IMPORTANT\][^\n]*\n[^\n]*\n\n\| \| \|/, 'disclaimer callout must end before the status table');
  assert.match(body, /<summary><b>📝 Review limitations \(1\)<\/b><\/summary>/);
});

test('links locations to the PR head only with a valid repository and commit SHA', () => {
  const sha = 'a'.repeat(40);
  const linked = renderReviewComment(sampleReview, { repository: 'example/healthcare-api', headSha: sha });
  assert.ok(linked.includes(`📍 [\`src/patient/log.ts#L20-L21\`](https://github.com/example/healthcare-api/blob/${sha}/src/patient/log.ts#L20-L21)`));

  const unlinked = renderReviewComment(sampleReview, { repository: 'example/healthcare-api', headSha: 'main' });
  assert.ok(unlinked.includes('📍 `src/patient/log.ts#L20-L21`'));
  assert.doesNotMatch(unlinked, /\]\(https:/);
});

test('shows reviewer URLs and paths as inline code without backslashes or live links', () => {
  const review = parseReviewResult({
    ...sampleReview,
    findings: [{
      ...sampleReview.findings[0],
      evidence: 'Default ANALYTICS_URL is http://ingest.example-analytics.io/v1 (see #12) and @someone\nsaid so.',
      location: { path: 'patient-service/src/config/env.ts', start_line: 67, end_line: 67 }
    }]
  });
  const body = renderReviewComment(review);
  assert.ok(body.includes('`http://ingest.example-analytics.io/v1`'));
  assert.ok(body.includes('`patient-service/src/config/env.ts#L67`'));
  assert.ok(body.includes('(see &#35;12) and &#64;someone said so.'));
  assert.doesNotMatch(body, /patient\\-service|ingest\\\./);
});
