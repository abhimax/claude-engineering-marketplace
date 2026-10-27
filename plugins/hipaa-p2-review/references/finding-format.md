# Finding Format

The reviewer returns one JSON object conforming to [`review-result.schema.json`](review-result.schema.json). The consuming adapter must parse and validate the model response against that schema before storing, displaying, or publishing it. A prompt requesting JSON does not guarantee valid JSON.

## Contract

- `schema_version`: contract version; currently `1.0.0`.
- `review_status`: `complete` only when the supplied scope was reviewable; otherwise `incomplete` with limitations in `uncertainties`.
- `findings`: deduplicated, actionable issues supported by supplied code evidence. An empty array means no evidence-supported finding was identified in the reviewed scope, not that the code is safe or compliant.
- `id`: unique within this result, sequential form `HPR-001`, `HPR-002`, and so on.
- `category`: one of the stable categories in the schema.
- `severity`: use an approved organization value only when its policy is available. Use `null` and explain the missing policy in `severity_rationale` when severity cannot be assigned. Never infer P2 from the healthcare context.
- `confidence`: the reviewer's confidence in the evidence and interpretation, not a severity level.
- `location`: repository-relative path and inclusive, one-based line numbers. Use only locations verified in the supplied diff or context.
- `evidence`: concise behavior or a minimal code excerpt. Redact PHI, credentials, and unnecessary sensitive values.
- `human_verification_required`: true when a condition, policy interpretation, or severity needs human confirmation.
- `uncertainties`: explicit missing context, assumptions, or policy gaps. Do not fabricate a complete review when scope is incomplete.

## Example

This is a synthetic illustration, not a claim about a real codebase or an approved severity policy:

```json
{
  "schema_version": "1.0.0",
  "review_status": "complete",
  "summary": "One potential data-access issue needs verification.",
  "findings": [
    {
      "id": "HPR-001",
      "category": "object_level_authorization",
      "severity": null,
      "severity_rationale": "No approved organizational severity criteria were supplied.",
      "confidence": "medium",
      "title": "Patient lookup may not enforce requester ownership",
      "location": {
        "path": "src/patients/lookup.ts",
        "start_line": 42,
        "end_line": 45
      },
      "evidence": "The changed lookup uses the request's record identifier; no ownership check is visible in the supplied handler or called function.",
      "impact": "If no upstream authorization check exists, a caller may retrieve another patient's record.",
      "remediation": "Verify the caller's authority for this record at the service boundary and add a test for cross-patient access.",
      "human_verification_required": true
    }
  ],
  "uncertainties": [
    "Confirm whether an upstream gateway enforces record-level authorization."
  ]
}
```