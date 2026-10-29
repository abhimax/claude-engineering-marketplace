import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type JsonRecord = Record<string, unknown>;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(filePath: string, root: string, errors: string[]): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${path.relative(root, filePath)}: invalid JSON (${message})`);
    return null;
  }
}

function isFrontmatterKey(key: string): boolean {
  if (key.length === 0 || key[0] < 'a' || key[0] > 'z') return false;
  for (const character of key) {
    const isLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (!isLetter && !isDigit && character !== '-') return false;
  }
  return true;
}

function readFrontmatter(filePath: string, root: string, errors: string[]): Map<string, string> | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    errors.push(`${path.relative(root, filePath)}: required Markdown file is missing or unreadable`);
    return null;
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    errors.push(`${path.relative(root, filePath)}: YAML frontmatter must start on the first line and have closing ---`);
    return null;
  }

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (isFrontmatterKey(key)) fields.set(key, line.slice(separator + 1).trim());
  }
  return fields;
}

function requireFile(root: string, relativePath: string, errors: string[]): void {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    errors.push(`${path.relative(root, filePath)}: required file is missing`);
  }
}

function validateMarketplaceMetadata(marketplace: JsonRecord, errors: string[]): unknown[] {
  if (typeof marketplace.name !== 'string' || !identifierPattern.test(marketplace.name)) {
    errors.push('marketplace.json: name must start with a letter or digit and use only letters, digits, dot, underscore, or hyphen');
  }
  if (!isRecord(marketplace.owner) || typeof marketplace.owner.name !== 'string' || marketplace.owner.name.trim() === '') {
    errors.push('marketplace.json: owner.name is required and must be non-empty');
  }
  if (typeof marketplace.description !== 'string' || marketplace.description.trim() === '') {
    errors.push('marketplace.json: description is required for this repository');
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    errors.push('marketplace.json: plugins must be a non-empty array');
    return [];
  }
  return marketplace.plugins as unknown[];
}

function resolvePluginRoot(root: string, entryName: string, source: unknown, errors: string[]): string | null {
  if (typeof source !== 'string' || !source.startsWith('./') || source.split('/').includes('..')) {
    errors.push(`marketplace.json: ${entryName} source must be a safe marketplace-root relative path beginning with ./`);
    return null;
  }

  const pluginRoot = path.resolve(root, source);
  if (!pluginRoot.startsWith(`${path.resolve(root)}${path.sep}`)) {
    errors.push(`marketplace.json: ${entryName} source resolves outside the marketplace root`);
    return null;
  }
  if (!fs.existsSync(pluginRoot) || !fs.statSync(pluginRoot).isDirectory()) {
    errors.push(`marketplace.json: ${entryName} source directory does not exist: ${source}`);
    return null;
  }
  return pluginRoot;
}

function validatePluginManifest(root: string, pluginRoot: string, entryName: string, source: string, errors: string[]): void {
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const manifest = readJson(manifestPath, root, errors);
  if (!isRecord(manifest)) return;
  if (manifest.name !== entryName) {
    errors.push(`${source}/.claude-plugin/plugin.json: name must match marketplace entry "${entryName}"`);
  }
  if (typeof manifest.version !== 'string') {
    errors.push(`${source}/.claude-plugin/plugin.json: version must be a string`);
  }
}

function validateFrontmatter(filePath: string, root: string, errors: string[]): void {
  const fields = readFrontmatter(filePath, root, errors);
  if (!fields) return;
  for (const field of ['name', 'description']) {
    if (!fields.get(field)) errors.push(`${path.relative(root, filePath)}: frontmatter requires ${field}`);
  }
}

function validatePluginComponents(root: string, pluginRoot: string, errors: string[]): void {
  validateFrontmatter(path.join(pluginRoot, 'agents', 'hipaa-p2-reviewer.md'), root, errors);
  validateFrontmatter(path.join(pluginRoot, 'skills', 'review-healthcare-pr', 'SKILL.md'), root, errors);
  validateFrontmatter(path.join(pluginRoot, 'commands', 'hipaa-review.md'), root, errors);
  validateFrontmatter(path.join(pluginRoot, 'commands', 'post-hipaa-review.md'), root, errors);
}

function validatePluginFiles(pluginRoot: string, errors: string[]): void {
  for (const relativePath of [
    'references/review-policy.md',
    'references/finding-format.md',
    'references/review-result.schema.json',
    'references/pr-comment-publishing.md',
    'references/review-procedure.md',
    'scripts/publish-pr-comment.mjs',
    'scripts/pr-setup.sh',
    'README.md'
  ]) {
    requireFile(pluginRoot, relativePath, errors);
  }
}

function validatePluginEntry(root: string, entry: unknown, names: Set<string>, errors: string[]): void {
  if (!isRecord(entry)) {
    errors.push('marketplace.json: each plugin entry must be an object');
    return;
  }
  if (typeof entry.name !== 'string' || !identifierPattern.test(entry.name)) {
    errors.push('marketplace.json: each plugin entry needs a valid name');
    return;
  }

  const entryName = entry.name;
  if (names.has(entryName)) errors.push(`marketplace.json: duplicate plugin identifier "${entryName}"`);
  names.add(entryName);

  const pluginRoot = resolvePluginRoot(root, entryName, entry.source, errors);
  if (!pluginRoot || typeof entry.source !== 'string') return;
  validatePluginManifest(root, pluginRoot, entryName, entry.source, errors);
  validatePluginComponents(root, pluginRoot, errors);
  validatePluginFiles(pluginRoot, errors);
}

function validateRepositoryFiles(root: string, errors: string[]): void {
  for (const relativePath of [
    'README.md',
    'CONTRIBUTING.md',
    'tests/README.md',
    'tests/validate-marketplace.test.ts',
    'tests/publish-pr-comment.test.ts',
    'tests/fixtures/patient-appointment-synthetic.json',
    'package.json',
    'scripts/validate-marketplace',
    '.github/workflows/validate-marketplace.yml'
  ]) {
    requireFile(root, relativePath, errors);
  }
}

export function validateMarketplace(root: string = repositoryRoot): string[] {
  const errors: string[] = [];
  const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json');
  const marketplace = readJson(marketplacePath, root, errors);
  if (!isRecord(marketplace)) return errors;

  const entries = validateMarketplaceMetadata(marketplace, errors);
  const names = new Set<string>();
  for (const entry of entries) validatePluginEntry(root, entry, names, errors);
  validateRepositoryFiles(root, errors);

  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateMarketplace(process.argv[2] ? path.resolve(process.argv[2]) : repositoryRoot);
  if (errors.length > 0) {
    for (const error of errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Structural marketplace checks passed.');
  }
}