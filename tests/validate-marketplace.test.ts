import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';
import { validateMarketplace } from '../scripts/validate-marketplace.ts';

interface SyntheticFixture {
  data_classification: string;
  patient: { id: string };
  appointment: { id: string; patient_id: string };
}

const resultSchema = JSON.parse(fs.readFileSync(new URL('../plugins/hipaa-p2-review/references/review-result.schema.json', import.meta.url), 'utf8')) as AnySchema;
const validateReviewResult = new Ajv2020({ allErrors: true }).compile(resultSchema);

function createFixture(): { root: string; pluginRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-validator-'));
  const pluginRoot = path.join(root, 'plugins', 'synthetic-review');
  const write = (relativePath: string, contents: string): void => {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
  };

  write('.claude-plugin/marketplace.json', JSON.stringify({
    name: 'synthetic-marketplace',
    description: 'Synthetic test marketplace',
    owner: { name: 'Test Engineering' },
    plugins: [{ name: 'synthetic-review', source: './plugins/synthetic-review' }]
  }));
  write('plugins/synthetic-review/.claude-plugin/plugin.json', JSON.stringify({ name: 'synthetic-review', version: '0.1.0' }));
  write('plugins/synthetic-review/agents/hipaa-p2-reviewer.md', '---\nname: reviewer\ndescription: Synthetic reviewer\n---\nInstructions.\n');
  write('plugins/synthetic-review/skills/review-healthcare-pr/SKILL.md', '---\nname: review\ndescription: Synthetic skill\n---\nInstructions.\n');
  write('plugins/synthetic-review/references/review-policy.md', 'Synthetic policy placeholder.\n');
  write('plugins/synthetic-review/references/finding-format.md', 'Synthetic output contract.\n');
  write('plugins/synthetic-review/references/review-result.schema.json', '{}');
  write('plugins/synthetic-review/README.md', 'Synthetic plugin documentation.\n');
  for (const file of [
    'README.md',
    'CONTRIBUTING.md',
    'tests/README.md',
    'tests/validate-marketplace.test.ts',
    'package.json',
    'scripts/validate-marketplace',
    '.github/workflows/validate-marketplace.yml'
  ]) write(file, '{}');
  write('tests/fixtures/patient-appointment-synthetic.json', JSON.stringify({
    data_classification: 'synthetic-test-data',
    patient: { id: 'SYNTHETIC-PATIENT-001' },
    appointment: { id: 'SYNTHETIC-APPOINTMENT-001', patient_id: 'SYNTHETIC-PATIENT-001' }
  }));

  return { root, pluginRoot };
}

test('accepts a structurally valid marketplace and matching plugin', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.deepEqual(validateMarketplace(fixture.root), []);
});

test('rejects duplicate plugin identifiers', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(fixture.root, '.claude-plugin', 'marketplace.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { plugins: Array<Record<string, unknown>> };
  manifest.plugins.push({ ...manifest.plugins[0] });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.match(validateMarketplace(fixture.root).join('\n'), /duplicate plugin identifier/);
});

test('rejects a plugin manifest name that differs from its catalog entry', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(fixture.pluginRoot, '.claude-plugin', 'plugin.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ name: 'different-name', version: '0.1.0' }));
  assert.match(validateMarketplace(fixture.root).join('\n'), /name must match marketplace entry/);
});

test('rejects traversal and missing source directories', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const manifestPath = path.join(fixture.root, '.claude-plugin', 'marketplace.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { plugins: Array<{ source: string }> };
  manifest.plugins[0].source = './../outside';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.match(validateMarketplace(fixture.root).join('\n'), /safe marketplace-root relative path/);

  manifest.plugins[0].source = './plugins/not-present';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.match(validateMarketplace(fixture.root).join('\n'), /source directory does not exist/);
});

test('rejects malformed or incomplete agent and skill frontmatter', (context) => {
  const fixture = createFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.pluginRoot, 'agents', 'hipaa-p2-reviewer.md'), '# Missing frontmatter\n');
  fs.writeFileSync(path.join(fixture.pluginRoot, 'skills', 'review-healthcare-pr', 'SKILL.md'), '---\nname: review\n---\nMissing description.\n');
  const errors = validateMarketplace(fixture.root).join('\n');
  assert.match(errors, /frontmatter must start on the first line/);
  assert.match(errors, /frontmatter requires description/);
});

test('accepts a review result that follows the documented output schema', () => {
  const result = {
    schema_version: '2.0.0',
    review_status: 'complete',
    summary: 'One potential access-control issue needs verification.',
    findings: [{
      id: 'HPR-001',
      alert: 'warning',
      category: 'endpoint_access_control',
      evidence_status: 'potential',
      confidence: 'medium',
      title: 'Patient lookup may not enforce requester ownership',
      location: { path: 'src/patients/lookup.ts', start_line: 42, end_line: 45 },
      evidence: 'The changed lookup uses the request record identifier; no ownership check is visible in supplied context.',
      risk: 'If no upstream authorization check exists, an unauthorized caller may retrieve another patient record.',
      recommendation: 'Verify record-level authority at the service boundary and test cross-patient access.',
      human_verification_required: true
    }],
    uncertainties: ['Confirm whether an upstream gateway enforces record-level authorization.']
  };
  assert.equal(validateReviewResult(result), true, JSON.stringify(validateReviewResult.errors));
});

test('accepts findings from all six review areas', () => {
  const categories = [
    'hardcoded_secret_credential',
    'phi_pii_leakage',
    'unmasked_test_data',
    'encryption_enforcement',
    'endpoint_access_control',
    'dependency_sca_baa'
  ];
  for (const category of categories) {
    const result = {
      schema_version: '2.0.0',
      review_status: 'complete',
      summary: 'One warning.',
      findings: [{
        id: 'HPR-001',
        alert: 'warning',
        category,
        evidence_status: 'potential',
        confidence: 'medium',
        title: 'Evidence requires verification',
        location: { path: 'src/changed.ts', start_line: 1, end_line: 1 },
        evidence: 'A relevant change is present; supporting context is not conclusive.',
        risk: 'The condition could expose or weaken protection of ePHI if confirmed.',
        recommendation: 'Verify the control and remediate if the risk is confirmed.',
        human_verification_required: true
      }],
      uncertainties: []
    };
    assert.equal(validateReviewResult(result), true, `${category}: ${JSON.stringify(validateReviewResult.errors)}`);
  }
});

test('rejects findings missing evidence location or verification fields', () => {
  const result = {
    schema_version: '2.0.0',
    review_status: 'complete',
    summary: 'One finding.',
    findings: [{ id: 'HPR-001', alert: 'warning', category: 'phi_pii_leakage' }],
    uncertainties: []
  };
  assert.equal(validateReviewResult(result), false);
  assert.ok(validateReviewResult.errors?.some((error) => error.keyword === 'required' && error.params.missingProperty === 'evidence_status'));
  assert.ok(validateReviewResult.errors?.some((error) => error.keyword === 'required' && error.params.missingProperty === 'risk'));
  assert.ok(validateReviewResult.errors?.some((error) => error.keyword === 'required' && error.params.missingProperty === 'recommendation'));
  assert.ok(validateReviewResult.errors?.some((error) => error.keyword === 'required' && error.params.missingProperty === 'human_verification_required'));
});

test('rejects severity assignments outside the warning contract', () => {
  const result = {
    schema_version: '2.0.0',
    review_status: 'complete',
    summary: 'One warning.',
    findings: [{
      id: 'HPR-001',
      alert: 'warning',
      category: 'phi_pii_leakage',
      evidence_status: 'confirmed',
      confidence: 'high',
      title: 'Patient identifier is written to application logs',
      location: { path: 'src/patients/log.ts', start_line: 10, end_line: 10 },
      evidence: 'The changed log statement includes a patient identifier.',
      risk: 'Log readers may access patient-identifying health data.',
      recommendation: 'Remove or irreversibly redact the identifier before logging.',
      human_verification_required: false,
      severity: 'P2'
    }],
    uncertainties: []
  };
  assert.equal(validateReviewResult(result), false);
  assert.ok(validateReviewResult.errors?.some((error) => error.keyword === 'additionalProperties' && error.params.additionalProperty === 'severity'));
});

test('uses only explicitly synthetic patient and appointment fixture data', () => {
  const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/patient-appointment-synthetic.json', import.meta.url), 'utf8')) as SyntheticFixture;
  assert.equal(fixture.data_classification, 'synthetic-test-data');
  assert.match(fixture.patient.id, /^SYNTHETIC-/);
  assert.match(fixture.appointment.id, /^SYNTHETIC-/);
  assert.equal(fixture.appointment.patient_id, fixture.patient.id);
});