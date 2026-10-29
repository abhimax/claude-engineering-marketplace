// Dependency-free so it runs from the installed plugin cache with `node` (22.18+ strips types natively).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

type JsonSchema = Record<string, unknown>;

const schemaUrl = new URL('../references/review-result.schema.json', import.meta.url);
const reviewSchema = JSON.parse(await fs.readFile(schemaUrl, 'utf8')) as JsonSchema;
const commentMarker = '<!-- healthcare-data-review -->';
const apiVersion = '2026-03-10';
const maxInputBytes = 2_000_000;
const maxCommentCharacters = 60_000;

interface ReviewLocation {
  path: string;
  start_line: number;
  end_line: number;
}

interface ReviewFinding {
  id: string;
  alert: 'warning';
  category: string;
  evidence_status: 'confirmed' | 'potential';
  confidence: 'high' | 'medium' | 'low';
  title: string;
  location: ReviewLocation;
  evidence: string;
  risk: string;
  recommendation: string;
  human_verification_required: boolean;
}

export interface ReviewResult {
  schema_version: '2.0.0';
  review_status: 'complete' | 'incomplete';
  summary: string;
  findings: ReviewFinding[];
  uncertainties: string[];
}

interface GitHubComment {
  id: number;
  body: string;
  user?: { login?: string } | null;
  html_url?: string;
}

export interface PublisherConfig {
  token: string;
  repository: string;
  pullRequestNumber: number;
  expectedAuthor: string;
  apiUrl?: string;
}

type Fetcher = typeof fetch;

// Interprets only the JSON Schema keywords review-result.schema.json uses, and refuses any other
// keyword so a schema change cannot silently weaken validation.
const supportedKeywords = new Set([
  '$schema', 'title', '$defs', '$ref', 'type', 'const', 'enum', 'required', 'additionalProperties',
  'properties', 'items', 'minLength', 'minimum', 'pattern'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveSchema(schema: JsonSchema): JsonSchema {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : '';
  const definitions = reviewSchema.$defs;
  if (!isRecord(definitions) || !isRecord(definitions[name])) throw new Error(`Unsupported schema reference ${ref}.`);
  return definitions[name];
}

function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    default: throw new Error(`Unsupported schema type ${String(type)}.`);
  }
}

function validateAgainstSchema(value: unknown, rawSchema: JsonSchema, path: string, errors: string[]): void {
  const schema = resolveSchema(rawSchema);
  for (const keyword of Object.keys(schema)) {
    if (!supportedKeywords.has(keyword)) throw new Error(`Unsupported schema keyword ${keyword}.`);
  }
  const at = path || '/';
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${at} must be ${String(schema.type)}`);
    return;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at} must be equal to constant`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at} must be equal to one of the allowed values`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && Array.from(value).length < schema.minLength) {
      errors.push(`${at} must NOT have fewer than ${schema.minLength} characters`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${at} must match pattern "${schema.pattern}"`);
    }
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    errors.push(`${at} must be >= ${schema.minimum}`);
  }
  if (Array.isArray(value) && isRecord(schema.items)) {
    value.forEach((item, index) => validateAgainstSchema(item, schema.items as JsonSchema, `${path}/${index}`, errors));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required as string[] : []) {
      if (!(key in value)) errors.push(`${at} must have required property '${key}'`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (isRecord(properties[key])) {
        validateAgainstSchema(child, properties[key], `${path}/${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${at} must NOT have additional properties`);
      }
    }
  }
}

function escapeMarkdown(value: string): string {
  const markdownCharacters = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '~', '|']);
  const escaped = Array.from(value, (character) =>
    markdownCharacters.has(character) ? `\\${character}` : character
  ).join('');
  return escaped
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('@', '&#64;');
}

export function renderReviewComment(review: ReviewResult): string {
  const sections = review.findings.map((finding) => {
    const location = `${finding.location.path}:${finding.location.start_line}-${finding.location.end_line}`;
    const humanCheck = finding.human_verification_required ? 'Required' : 'Not indicated';
    return [
      `### ${escapeMarkdown(finding.title)}`,
      `**Warning:** ${escapeMarkdown(finding.category)} · ${escapeMarkdown(finding.evidence_status)} · confidence ${finding.confidence}`,
      `**Location:** \`${escapeMarkdown(location)}\``,
      `**Evidence:** ${escapeMarkdown(finding.evidence)}`,
      `**Risk:** ${escapeMarkdown(finding.risk)}`,
      `**Recommendation:** ${escapeMarkdown(finding.recommendation)}`,
      `**Human verification:** ${humanCheck}`
    ].join('\n\n');
  });

  const findingsBody = sections.length > 0
    ? sections.join('\n\n---\n\n')
    : 'No evidence-backed warning was identified in the assessable supplied scope. This is not a compliance determination.';
  const uncertainties = review.uncertainties.length > 0
    ? '\n\n### Review limitations\n' + review.uncertainties.map((item) => '- ' + escapeMarkdown(item)).join('\n')
    : '';

  const body = [
    commentMarker,
    '## Healthcare Privacy and Access Review',
    '',
    '> Automated review warning only. Human verification is required. This comment may contain sensitive review context; confirm it is appropriate for this repository before publishing. It does not determine HIPAA compliance.',
    '',
    `**Review status:** ${review.review_status}`,
    '',
    escapeMarkdown(review.summary),
    '',
    findingsBody,
    uncertainties,
    '',
    '_Generated by the Healthcare Privacy and Access Review plugin. No severity score is assigned._'
  ].filter((line) => line.length > 0).join('\n');
  if (body.length > maxCommentCharacters) {
    throw new Error(`Rendered PR comment exceeds the ${maxCommentCharacters}-character limit.`);
  }
  return body;
}

function getApiBase(apiUrl?: string): URL {
  const base = new URL(apiUrl ?? 'https://api.github.com');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('GitHub API URL must be HTTPS and must not contain credentials, query, or fragment.');
  }
  return new URL(base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`);
}

function repositoryParts(repository: string): { owner: string; repo: string } {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error('GITHUB_REPOSITORY must use the owner/repository form.');
  }
  return { owner: parts[0], repo: parts[1] };
}

function apiHeaders(token: string): HeadersInit {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': apiVersion,
    'Content-Type': 'application/json'
  };
}

async function requestJson<T>(url: URL, init: RequestInit, fetcher: Fetcher): Promise<T> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}. Response body omitted.`);
  }
  return await response.json() as T;
}

async function listPullRequestComments(
  apiBase: URL,
  token: string,
  owner: string,
  repo: string,
  pullRequestNumber: number,
  fetcher: Fetcher
): Promise<GitHubComment[]> {
  const comments: GitHubComment[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullRequestNumber}/comments`, apiBase);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    const pageComments = await requestJson<GitHubComment[]>(url, {
      method: 'GET',
      headers: apiHeaders(token)
    }, fetcher);
    comments.push(...pageComments);
    if (pageComments.length < 100) return comments;
  }
  throw new Error('Too many PR comments to safely locate the existing review comment.');
}

export function validatePublisherConfig(config: PublisherConfig): void {
  if (!config.token.trim()) throw new Error('A GitHub token is required for publishing.');
  repositoryParts(config.repository);
  if (!Number.isSafeInteger(config.pullRequestNumber) || config.pullRequestNumber < 1) {
    throw new Error('PR_NUMBER must be a positive integer.');
  }
  if (!config.expectedAuthor.trim()) throw new Error('GH_COMMENT_AUTHOR_LOGIN is required for safe comment updates.');
  getApiBase(config.apiUrl);
}

export function assertPostApproval(approved: string | undefined): void {
  if (approved !== 'true') {
    throw new Error('Posting is disabled unless PR_COMMENT_APPROVED=true is explicitly set after human review.');
  }
}

export function parseReviewResult(input: unknown): ReviewResult {
  const errors: string[] = [];
  validateAgainstSchema(input, reviewSchema, '', errors);
  if (errors.length > 0) {
    throw new Error(`Review JSON failed schema validation: ${errors.join('; ')}`);
  }
  return input as ReviewResult;
}

export function repositoryFromRemote(remoteUrl: string): string | undefined {
  const withoutCredentials = remoteUrl.trim().replace(/^https?:\/\/[^@/]+@/, 'https://');
  const match = withoutCredentials.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1];
}

function readOriginRemote(): string {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// Fills gaps the platform did not configure: repository from a github.com origin, token from
// GITHUB_TOKEN, and the comment author from the token's own identity. Explicit env always wins.
export async function resolvePublisherConfig(
  env: NodeJS.ProcessEnv,
  fetcher: Fetcher = fetch,
  readRemote: () => string = readOriginRemote
): Promise<PublisherConfig> {
  const config: PublisherConfig = {
    token: env.GH_TOKEN || env.GITHUB_TOKEN || '',
    repository: env.GITHUB_REPOSITORY || repositoryFromRemote(readRemote()) || '',
    pullRequestNumber: Number(env.PR_NUMBER),
    expectedAuthor: env.GH_COMMENT_AUTHOR_LOGIN ?? '',
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {})
  };
  if (!config.repository) {
    throw new Error('Set GITHUB_REPOSITORY=owner/repo; it could not be derived from a github.com origin remote.');
  }
  if (!config.expectedAuthor.trim() && config.token.trim()) {
    try {
      const user = await requestJson<{ login?: string }>(new URL('user', getApiBase(config.apiUrl)), {
        method: 'GET',
        headers: apiHeaders(config.token)
      }, fetcher);
      config.expectedAuthor = user.login ?? '';
    } catch {
      throw new Error('Set GH_COMMENT_AUTHOR_LOGIN; the token identity could not be read from GET /user.');
    }
  }
  validatePublisherConfig(config);
  return config;
}

export async function publishReviewComment(
  review: ReviewResult,
  config: PublisherConfig,
  fetcher: Fetcher = fetch
): Promise<{ action: 'created' | 'updated'; url?: string }> {
  validatePublisherConfig(config);
  const apiBase = getApiBase(config.apiUrl);
  const { owner, repo } = repositoryParts(config.repository);
  const comments = await listPullRequestComments(apiBase, config.token, owner, repo, config.pullRequestNumber, fetcher);
  const ownedMarkerComments = comments.filter((comment) =>
    comment.user?.login?.toLowerCase() === config.expectedAuthor.toLowerCase() && comment.body.includes(commentMarker)
  );
  if (ownedMarkerComments.length > 1) {
    throw new Error('Multiple bot-owned review comments found; refusing ambiguous update.');
  }

  const body = renderReviewComment(review);
  const existing = ownedMarkerComments[0];
  if (existing) {
    const updated = await requestJson<GitHubComment>(new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existing.id}`,
      apiBase
    ), {
      method: 'PATCH',
      headers: apiHeaders(config.token),
      body: JSON.stringify({ body })
    }, fetcher);
    return { action: 'updated', url: updated.html_url };
  }

  const created = await requestJson<GitHubComment>(new URL(
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${config.pullRequestNumber}/comments`,
    apiBase
  ), {
    method: 'POST',
    headers: apiHeaders(config.token),
    body: JSON.stringify({ body })
  }, fetcher);
  return { action: 'created', url: created.html_url };
}

async function readInput(inputPath: string): Promise<string> {
  if (inputPath === '-') {
    let input = '';
    for await (const chunk of process.stdin) {
      input += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(input, 'utf8') > maxInputBytes) {
        throw new Error(`Review input exceeds the ${maxInputBytes}-byte limit.`);
      }
    }
    return input;
  }
  const input = await fs.readFile(inputPath, 'utf8');
  if (Buffer.byteLength(input, 'utf8') > maxInputBytes) {
    throw new Error(`Review input exceeds the ${maxInputBytes}-byte limit.`);
  }
  return input;
}

async function main(args: string[]): Promise<void> {
  const post = args.includes('--post');
  const positional = args.filter((arg) => arg !== '--post');
  if (positional.length !== 1) {
    throw new Error('Usage: node publish-pr-comment.mts [--post] <review.json|->');
  }

  const input = JSON.parse(await readInput(positional[0])) as unknown;
  const review = parseReviewResult(input);
  const body = renderReviewComment(review);
  if (!post) {
    process.stdout.write(`${body}\n`);
    process.stderr.write('Dry run only. No GitHub request was made.\n');
    return;
  }
  assertPostApproval(process.env.PR_COMMENT_APPROVED);

  const config = await resolvePublisherConfig(process.env);
  const result = await publishReviewComment(review, config);
  const destination = result.url ? ': ' + result.url : '.';
  console.log(`GitHub PR comment ${result.action} on ${config.repository}#${config.pullRequestNumber} with ${review.findings.length} warning(s)${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown publisher error.';
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  }
}
