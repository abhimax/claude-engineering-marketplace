// @ts-check
// Plain JavaScript with no dependencies so it runs from the installed plugin cache on any Node.js 18+,
// whatever runtime the reviewed repository pins.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** @typedef {Record<string, unknown>} JsonSchema */

const schemaUrl = new URL('../references/review-result.schema.json', import.meta.url);
/** @type {JsonSchema} */
const reviewSchema = JSON.parse(await fs.readFile(schemaUrl, 'utf8'));
const commentMarker = '<!-- healthcare-data-review -->';
const apiVersion = '2026-03-10';
const maxInputBytes = 2_000_000;
const maxCommentCharacters = 60_000;
const defaultApprovalLabel = 'ai-dlc/pr/hipaa-p2-review';

/**
 * @typedef {object} ReviewLocation
 * @property {string} path
 * @property {number} start_line
 * @property {number} end_line
 */

/**
 * @typedef {object} ReviewFinding
 * @property {string} id
 * @property {'warning'} alert
 * @property {string} category
 * @property {'confirmed' | 'potential'} evidence_status
 * @property {'high' | 'medium' | 'low'} confidence
 * @property {string} title
 * @property {ReviewLocation} location
 * @property {string} evidence
 * @property {string} risk
 * @property {string} recommendation
 * @property {boolean} human_verification_required
 */

/**
 * @typedef {object} ReviewResult
 * @property {'2.0.0'} schema_version
 * @property {'complete' | 'incomplete'} review_status
 * @property {string} summary
 * @property {ReviewFinding[]} findings
 * @property {string[]} uncertainties
 */

/**
 * @typedef {object} GitHubComment
 * @property {number} id
 * @property {string} body
 * @property {{ login?: string } | null} [user]
 * @property {string} [html_url]
 */

/**
 * @typedef {object} PublisherConfig
 * @property {string} token
 * @property {string} repository
 * @property {number} pullRequestNumber
 * @property {string} expectedAuthor
 * @property {string} [apiUrl]
 */

/** @typedef {typeof fetch} Fetcher */

// Interprets only the JSON Schema keywords review-result.schema.json uses, and refuses any other
// keyword so a schema change cannot silently weaken validation.
const supportedKeywords = new Set([
  '$schema', 'title', '$defs', '$ref', 'type', 'const', 'enum', 'required', 'additionalProperties',
  'properties', 'items', 'minLength', 'minimum', 'pattern'
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {JsonSchema} schema
 * @returns {JsonSchema}
 */
function resolveSchema(schema) {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : '';
  const definitions = reviewSchema.$defs;
  if (!isRecord(definitions) || !isRecord(definitions[name])) throw new Error(`Unsupported schema reference ${ref}.`);
  return definitions[name];
}

/**
 * @param {unknown} value
 * @param {unknown} type
 */
function matchesType(value, type) {
  switch (type) {
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'integer': return Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    default: throw new Error(`Unsupported schema type ${String(type)}.`);
  }
}

/**
 * @param {unknown} value
 * @param {JsonSchema} rawSchema
 * @param {string} path
 * @param {string[]} errors
 */
function validateAgainstSchema(value, rawSchema, path, errors) {
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
    const items = schema.items;
    value.forEach((item, index) => validateAgainstSchema(item, items, `${path}/${index}`, errors));
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
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

/** @type {Record<string, { icon: string, label: string }>} */
const categoryDisplay = {
  hardcoded_secret_credential: { icon: '🔑', label: 'Hardcoded secrets & credentials' },
  phi_pii_leakage: { icon: '🩺', label: 'PHI/PII leakage' },
  unmasked_test_data: { icon: '🧪', label: 'Unmasked test data' },
  encryption_enforcement: { icon: '🔒', label: 'Encryption enforcement' },
  endpoint_access_control: { icon: '🛡️', label: 'Endpoint access control' },
  dependency_sca_baa: { icon: '📦', label: 'Dependencies, SCA & BAA' }
};

// Colours mark evidence status only; the review contract assigns no severity.
const evidenceDisplay = {
  confirmed: '🔴 **Confirmed**',
  potential: '🟡 **Potential** — needs verification'
};

const confidenceDisplay = {
  high: '●●● High',
  medium: '●●○ Medium',
  low: '●○○ Low'
};

/**
 * @typedef {object} RenderContext
 * @property {string} [repository] owner/repo, used to link locations
 * @property {string} [headSha] PR head commit, used to link locations
 */

/**
 * Inline code is never parsed as Markdown or HTML, so it is the safest container for raw values.
 * @param {string} value
 * @returns {string}
 */
function codeSpan(value) {
  return `\`${value.replace(/\s+/g, ' ').replaceAll('`', "'")}\``;
}

/**
 * Escapes reviewer-controlled text for inline Markdown: no formatting, links, HTML, mentions, or
 * issue references. URLs become inline code so they are shown but never turned into live links.
 * @param {string} value
 * @returns {string}
 */
function escapeInline(value) {
  const inlineSyntax = new Set(['\\', '`', '*', '_', '[', ']', '~', '|']);
  const htmlEntities = /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '@': '&#64;', '#': '&#35;' });
  const escapeText = (/** @type {string} */ text) => Array.from(text, (character) =>
    htmlEntities[character] ?? (inlineSyntax.has(character) ? `\\${character}` : character)
  ).join('');
  const urlPattern = /\b(?:https?:\/\/|www\.)[^\s<>`]+/gi;
  const flattened = value.replace(/\s+/g, ' ').trim();
  let output = '';
  let last = 0;
  for (const match of flattened.matchAll(urlPattern)) {
    const index = match.index ?? 0;
    output += escapeText(flattened.slice(last, index)) + codeSpan(match[0]);
    last = index + match[0].length;
  }
  return output + escapeText(flattened.slice(last));
}

/**
 * @param {ReviewLocation} location
 * @param {RenderContext} context
 * @returns {string}
 */
function renderLocation(location, context) {
  const lines = location.start_line === location.end_line
    ? `L${location.start_line}`
    : `L${location.start_line}-L${location.end_line}`;
  const label = codeSpan(`${location.path}#${lines}`);
  const repository = context.repository && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ? context.repository : '';
  const headSha = context.headSha && /^[0-9a-f]{40}$/.test(context.headSha) ? context.headSha : '';
  if (!repository || !headSha || location.path.split('/').some((segment) => segment === '..' || segment === '')) return label;
  const path = location.path.split('/').map(encodeURIComponent).join('/');
  return `[${label}](https://github.com/${repository}/blob/${headSha}/${path}#${lines})`;
}

/**
 * @param {string} kind
 * @param {string} title
 * @param {string} text
 * @returns {string[]}
 */
function alertBlock(kind, title, text) {
  return [`> [!${kind}]`, `> **${title}**`, `> ${escapeInline(text)}`];
}

/**
 * @param {ReviewResult} review
 * @param {RenderContext} [context]
 * @returns {string}
 */
export function renderReviewComment(review, context = {}) {
  const confirmed = review.findings.filter((finding) => finding.evidence_status === 'confirmed').length;
  const potential = review.findings.length - confirmed;
  const needsHuman = review.findings.filter((finding) => finding.human_verification_required).length;
  const status = review.review_status === 'complete'
    ? '✅ Complete'
    : '⚠️ Incomplete — part of the scope could not be reviewed';

  const lines = [
    commentMarker,
    '## 🩺 Healthcare Privacy & Access Review',
    '',
    '> [!IMPORTANT]',
    '> **Automated review — human verification required.** Warnings are risk signals, not a HIPAA compliance determination, and no severity score is assigned.',
    '',
    '| | |',
    '|:--|:--|',
    `| **Review status** | ${status} |`,
    `| **Warnings** | ${review.findings.length === 0 ? '✅ None found' : `⚠️ ${review.findings.length} — 🔴 ${confirmed} confirmed · 🟡 ${potential} potential`} |`,
    `| **Needs human check** | 👤 ${needsHuman} of ${review.findings.length} |`,
    '',
    `**Summary:** ${escapeInline(review.summary)}`,
    '',
    '### 📊 Coverage by review area',
    '',
    '| Area | Result |',
    '|:--|:--|'
  ];
  for (const [category, display] of Object.entries(categoryDisplay)) {
    const count = review.findings.filter((finding) => finding.category === category).length;
    lines.push(`| ${display.icon} ${display.label} | ${count === 0 ? '✅ No warnings' : `⚠️ ${count} warning${count === 1 ? '' : 's'}`} |`);
  }

  lines.push('', '### 🔎 Findings', '');
  if (review.findings.length === 0) {
    lines.push('> [!TIP]', '> ✅ No evidence-backed warning was identified in the assessable supplied scope. This is not a compliance determination.', '');
  }
  review.findings.forEach((finding, index) => {
    const display = categoryDisplay[finding.category] ?? { icon: '⚠️', label: finding.category };
    if (index > 0) lines.push('---', '');
    lines.push(
      `#### ${display.icon} ${codeSpan(finding.id)} ${escapeInline(finding.title)}`,
      '',
      `${evidenceDisplay[finding.evidence_status]} · Confidence ${confidenceDisplay[finding.confidence]} · ${display.label}${finding.human_verification_required ? ' · 👤 Human check required' : ''}`,
      '',
      `📍 ${renderLocation(finding.location, context)}`,
      '',
      ...alertBlock('NOTE', '🔍 Evidence', finding.evidence),
      '',
      ...alertBlock('CAUTION', '⚠️ Risk', finding.risk),
      '',
      ...alertBlock('TIP', '✅ Recommendation', finding.recommendation),
      ''
    );
  });

  if (review.uncertainties.length > 0) {
    lines.push(
      '<details>',
      `<summary><b>📝 Review limitations (${review.uncertainties.length})</b></summary>`,
      '',
      ...review.uncertainties.map((item) => `- ℹ️ ${escapeInline(item)}`),
      '',
      '</details>',
      ''
    );
  }
  lines.push('<sub>🤖 Generated by the Healthcare Privacy and Access Review plugin · Report-only · Rerunning the review updates this comment.</sub>');

  const body = lines.join('\n');
  if (body.length > maxCommentCharacters) {
    throw new Error(`Rendered PR comment exceeds the ${maxCommentCharacters}-character limit.`);
  }
  return body;
}

/**
 * @param {string} [apiUrl]
 * @returns {URL}
 */
function getApiBase(apiUrl) {
  const base = new URL(apiUrl ?? 'https://api.github.com');
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('GitHub API URL must be HTTPS and must not contain credentials, query, or fragment.');
  }
  return new URL(base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`);
}

/**
 * @param {string} repository
 * @returns {{ owner: string, repo: string }}
 */
function repositoryParts(repository) {
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))) {
    throw new Error('GITHUB_REPOSITORY must use the owner/repository form.');
  }
  return { owner: parts[0], repo: parts[1] };
}

/**
 * @param {string} token
 * @returns {Record<string, string>}
 */
function apiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': apiVersion,
    'Content-Type': 'application/json'
  };
}

/**
 * @template T
 * @param {URL} url
 * @param {RequestInit} init
 * @param {Fetcher} fetcher
 * @returns {Promise<T>}
 */
async function requestJson(url, init, fetcher) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with HTTP ${response.status}. Response body omitted.`);
  }
  return /** @type {T} */ (await response.json());
}

/**
 * @param {URL} apiBase
 * @param {string} token
 * @param {string} owner
 * @param {string} repo
 * @param {number} pullRequestNumber
 * @param {Fetcher} fetcher
 * @returns {Promise<GitHubComment[]>}
 */
async function listPullRequestComments(apiBase, token, owner, repo, pullRequestNumber, fetcher) {
  /** @type {GitHubComment[]} */
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullRequestNumber}/comments`, apiBase);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    /** @type {GitHubComment[]} */
    const pageComments = await requestJson(url, {
      method: 'GET',
      headers: apiHeaders(token)
    }, fetcher);
    comments.push(...pageComments);
    if (pageComments.length < 100) return comments;
  }
  throw new Error('Too many PR comments to safely locate the existing review comment.');
}

/**
 * @param {PublisherConfig} config
 */
export function validatePublisherConfig(config) {
  if (!config.token.trim()) throw new Error('A GitHub token is required for publishing.');
  repositoryParts(config.repository);
  if (!Number.isSafeInteger(config.pullRequestNumber) || config.pullRequestNumber < 1) {
    throw new Error('PR_NUMBER must be a positive integer.');
  }
  if (!config.expectedAuthor.trim()) throw new Error('GH_COMMENT_AUTHOR_LOGIN is required for safe comment updates.');
  getApiBase(config.apiUrl);
}

/**
 * @param {string | undefined} approved
 */
export function assertPostApproval(approved) {
  if (approved !== 'true') {
    throw new Error('Posting is disabled unless PR_COMMENT_APPROVED=true is explicitly set after human review.');
  }
}

// A PR label is approval only when GitHub reports it on the PR itself. Applying a label needs
// triage/write access, so PR text or the model cannot grant it.
/**
 * @param {PublisherConfig} config
 * @param {string} label
 * @param {Fetcher} [fetcher]
 * @returns {Promise<boolean>}
 */
export async function hasApprovalLabel(config, label, fetcher = fetch) {
  validatePublisherConfig(config);
  const { owner, repo } = repositoryParts(config.repository);
  const url = new URL(`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${config.pullRequestNumber}/labels`, getApiBase(config.apiUrl));
  url.searchParams.set('per_page', '100');
  /** @type {Array<{ name?: string }>} */
  const labels = await requestJson(url, { method: 'GET', headers: apiHeaders(config.token) }, fetcher);
  return labels.some((item) => item.name === label);
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {PublisherConfig} config
 * @param {Fetcher} [fetcher]
 * @returns {Promise<'environment' | 'label'>}
 */
export async function resolvePostApproval(env, config, fetcher = fetch) {
  if (env.PR_COMMENT_APPROVED === 'true') return 'environment';
  const label = env.HIPAA_REVIEW_APPROVAL_LABEL || defaultApprovalLabel;
  if (await hasApprovalLabel(config, label, fetcher)) return 'label';
  throw new Error(`Posting is disabled unless PR_COMMENT_APPROVED=true is explicitly set after human review or the PR has the '${label}' label.`);
}

/**
 * @param {unknown} input
 * @returns {ReviewResult}
 */
export function parseReviewResult(input) {
  /** @type {string[]} */
  const errors = [];
  validateAgainstSchema(input, reviewSchema, '', errors);
  if (errors.length > 0) {
    throw new Error(`Review JSON failed schema validation: ${errors.join('; ')}`);
  }
  return /** @type {ReviewResult} */ (input);
}

/**
 * @param {string} remoteUrl
 * @returns {string | undefined}
 */
export function repositoryFromRemote(remoteUrl) {
  const withoutCredentials = remoteUrl.trim().replace(/^https?:\/\/[^@/]+@/, 'https://');
  const match = withoutCredentials.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return match?.[1];
}

/** @returns {string} */
function readOriginRemote() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

// Fills gaps the platform did not configure: repository from a github.com origin, token from
// GITHUB_TOKEN, and the comment author from the token's own identity. Explicit env always wins.
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Fetcher} [fetcher]
 * @param {() => string} [readRemote]
 * @returns {Promise<PublisherConfig>}
 */
export async function resolvePublisherConfig(env, fetcher = fetch, readRemote = readOriginRemote) {
  /** @type {PublisherConfig} */
  const config = {
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
      /** @type {{ login?: string }} */
      const user = await requestJson(new URL('user', getApiBase(config.apiUrl)), {
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

/**
 * @param {ReviewResult} review
 * @param {PublisherConfig} config
 * @param {Fetcher} [fetcher]
 * @param {RenderContext} [context]
 * @returns {Promise<{ action: 'created' | 'updated', url?: string }>}
 */
export async function publishReviewComment(review, config, fetcher = fetch, context = {}) {
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

  const body = renderReviewComment(review, context);
  const existing = ownedMarkerComments[0];
  if (existing) {
    /** @type {GitHubComment} */
    const updated = await requestJson(new URL(
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/comments/${existing.id}`,
      apiBase
    ), {
      method: 'PATCH',
      headers: apiHeaders(config.token),
      body: JSON.stringify({ body })
    }, fetcher);
    return { action: 'updated', url: updated.html_url };
  }

  /** @type {GitHubComment} */
  const created = await requestJson(new URL(
    `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${config.pullRequestNumber}/comments`,
    apiBase
  ), {
    method: 'POST',
    headers: apiHeaders(config.token),
    body: JSON.stringify({ body })
  }, fetcher);
  return { action: 'created', url: created.html_url };
}

/**
 * @param {string} inputPath
 * @returns {Promise<string>}
 */
async function readInput(inputPath) {
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

/**
 * @param {string[]} args
 */
async function main(args) {
  const post = args.includes('--post');
  const positional = args.filter((arg) => arg !== '--post');
  if (positional.length !== 1) {
    throw new Error('Usage: node publish-pr-comment.mjs [--post] <review.json|->');
  }

  /** @type {unknown} */
  const input = JSON.parse(await readInput(positional[0]));
  const review = parseReviewResult(input);
  /** @type {RenderContext} */
  const context = {
    repository: process.env.GITHUB_REPOSITORY || repositoryFromRemote(readOriginRemote()),
    headSha: process.env.HEAD_SHA
  };
  const body = renderReviewComment(review, context);
  if (!post) {
    process.stdout.write(`${body}\n`);
    process.stderr.write('Dry run only. No GitHub request was made.\n');
    return;
  }
  const config = await resolvePublisherConfig(process.env);
  const approval = await resolvePostApproval(process.env, config);
  process.stderr.write(`Posting approved by ${approval === 'label' ? 'PR opt-in label' : 'PR_COMMENT_APPROVED'}.\n`);
  const result = await publishReviewComment(review, config, fetch, { ...context, repository: config.repository });
  const destination = result.url ? ': ' + result.url : '.';
  console.log(`GitHub PR comment ${result.action} on ${config.repository}#${config.pullRequestNumber} with ${review.findings.length} warning(s)${destination}`);
}

// Compare real paths: plugin caches and /tmp are often symlinks, and a mismatch would skip main() and exit 0 silently.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown publisher error.';
    console.error(`ERROR: ${message}`);
    process.exitCode = 1;
  }
}
