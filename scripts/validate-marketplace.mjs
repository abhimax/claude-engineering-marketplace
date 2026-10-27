import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function readJson(filePath, root, errors) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    errors.push(`${path.relative(root, filePath)}: invalid JSON (${error.message})`);
    return null;
  }
}

function isFrontmatterKey(key) {
  if (key.length === 0 || key[0] < 'a' || key[0] > 'z') return false;
  for (const character of key) {
    const isLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (!isLetter && !isDigit && character !== '-') return false;
  }
  return true;
}

function readFrontmatter(filePath, root, errors) {
  let content;
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

  const fields = new Map();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (isFrontmatterKey(key)) fields.set(key, line.slice(separator + 1).trim());
  }
  return fields;
}

function requireFile(root, relativePath, errors) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    errors.push(`${path.relative(root, filePath)}: required file is missing`);
  }
}

function validateMarketplaceMetadata(marketplace, errors) {
  if (typeof marketplace.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(marketplace.name)) {
    errors.push('marketplace.json: name must start with a letter or digit and use only letters, digits, dot, underscore, or hyphen');
  }
  if (typeof marketplace.owner?.name !== 'string' || marketplace.owner.name.trim() === '') {
    errors.push('marketplace.json: owner.name is required and must be non-empty');
  }
  if (typeof marketplace.description !== 'string' || marketplace.description.trim() === '') {
    errors.push('marketplace.json: description is required for this repository');
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    errors.push('marketplace.json: plugins must be a non-empty array');
    return [];
  }
  return marketplace.plugins;
}

function resolvePluginRoot(root, entry, errors) {
  if (typeof entry.source !== 'string' || !entry.source.startsWith('./') || entry.source.split('/').includes('..')) {
    errors.push(`marketplace.json: ${entry.name} source must be a safe marketplace-root relative path beginning with ./`);
    return null;
  }

  const pluginRoot = path.resolve(root, entry.source);
  if (!pluginRoot.startsWith(`${path.resolve(root)}${path.sep}`)) {
    errors.push(`marketplace.json: ${entry.name} source resolves outside the marketplace root`);
    return null;
  }
  if (!fs.existsSync(pluginRoot) || !fs.statSync(pluginRoot).isDirectory()) {
    errors.push(`marketplace.json: ${entry.name} source directory does not exist: ${entry.source}`);
    return null;
  }
  return pluginRoot;
}

function validatePluginManifest(root, pluginRoot, entry, errors) {
  const manifestPath = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  const manifest = readJson(manifestPath, root, errors);
  if (!manifest) return;
  if (manifest.name !== entry.name) {
    errors.push(`${entry.source}/.claude-plugin/plugin.json: name must match marketplace entry "${entry.name}"`);
  }
  if (typeof manifest.version !== 'string') {
    errors.push(`${entry.source}/.claude-plugin/plugin.json: version must be a string`);
  }
}

function validateFrontmatter(filePath, root, errors) {
  const fields = readFrontmatter(filePath, root, errors);
  if (!fields) return;
  for (const field of ['name', 'description']) {
    if (!fields.get(field)) errors.push(`${path.relative(root, filePath)}: frontmatter requires ${field}`);
  }
}

function validatePluginComponents(root, pluginRoot, errors) {
  validateFrontmatter(path.join(pluginRoot, 'agents', 'hipaa-p2-reviewer.md'), root, errors);
  validateFrontmatter(path.join(pluginRoot, 'skills', 'review-healthcare-pr', 'SKILL.md'), root, errors);
}

function validatePluginFiles(pluginRoot, errors) {
  for (const relativePath of [
    'references/review-policy.md',
    'references/finding-format.md',
    'references/review-result.schema.json',
    'README.md'
  ]) {
    requireFile(pluginRoot, relativePath, errors);
  }
}

function validatePluginEntry(root, entry, names, errors) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push('marketplace.json: each plugin entry must be an object');
    return;
  }
  if (typeof entry.name !== 'string' || !identifierPattern.test(entry.name)) {
    errors.push('marketplace.json: each plugin entry needs a valid name');
    return;
  }
  if (names.has(entry.name)) errors.push(`marketplace.json: duplicate plugin identifier "${entry.name}"`);
  names.add(entry.name);

  const pluginRoot = resolvePluginRoot(root, entry, errors);
  if (!pluginRoot) return;
  validatePluginManifest(root, pluginRoot, entry, errors);
  validatePluginComponents(root, pluginRoot, errors);
  validatePluginFiles(pluginRoot, errors);
}

function validateRepositoryFiles(root, errors) {
  for (const relativePath of [
    'README.md',
    'CONTRIBUTING.md',
    'tests/README.md',
    'tests/validate-marketplace.test.mjs',
    'tests/fixtures/patient-appointment-synthetic.json',
    'package.json',
    'scripts/validate-marketplace',
    '.github/workflows/validate-marketplace.yml'
  ]) {
    requireFile(root, relativePath, errors);
  }
}

export function validateMarketplace(root = repositoryRoot) {
  const errors = [];
  const marketplacePath = path.join(root, '.claude-plugin', 'marketplace.json');
  const marketplace = readJson(marketplacePath, root, errors);
  if (!marketplace) return errors;

  const entries = validateMarketplaceMetadata(marketplace, errors);
  const names = new Set();
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