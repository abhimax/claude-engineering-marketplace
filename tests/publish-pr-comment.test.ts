import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPostApproval,
  parseReviewResult,
  publishReviewComment,
  renderReviewComment,
  validatePublisherConfig,
  type PublisherConfig
} from '../scripts/publish-pr-comment.ts';

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
  assert.ok(body.includes('&lt;script&gt;alert\\(1\\)&lt;/script&gt; \\| summary'));
  assert.doesNotMatch(body, /<script>|@everyone/);
  assert.match(body, /\*\*Risk:\*\*/);
  assert.match(body, /\*\*Recommendation:\*\*/);
  assert.match(body, /<!-- healthcare-data-review -->/);
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