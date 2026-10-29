# Finding Format

The reviewer returns one JSON object conforming to [`review-result.schema.json`](review-result.schema.json). The consuming adapter must parse and validate the model response against that schema before storing, displaying, or publishing it. A prompt requesting JSON does not guarantee valid JSON.

## Contract

- `schema_version`: contract version; currently `2.0.0`. Version 2 removes severity fields and adopts the warning/risk contract.
- `review_status`: `complete` only when the supplied scope was reviewable; otherwise `incomplete` with limitations in `uncertainties`.
- `findings`: deduplicated, actionable warning records supported by supplied evidence. An empty array means no evidence-backed issue was found in the assessable supplied scope; it is not proof of safety or compliance.
- `id`: unique within this result, sequential form `HPR-001`, `HPR-002`, and so on.
- `alert`: always `warning`; this is an alert label, not a severity score.
- `category`: one of the six review areas in the schema.
- `evidence_status`: `confirmed` when evidence demonstrates the issue, or `potential` when verification is needed.
- `confidence`: the reviewer's confidence in the evidence and interpretation.
- `location`: repository-relative path and inclusive, one-based line numbers. Use only locations verified in the supplied diff or context.
- `evidence`: concise behavior or supplied scanner/approval evidence. Redact PHI, secrets, and unnecessary sensitive values.
- `risk`: concrete potential consequence, phrased conditionally when the finding is potential.
- `recommendation`: specific remediation or verification action.
- `human_verification_required`: true when provenance, effective deployment controls, scanner results, or vendor approval/BAA context needs confirmation.
- `uncertainties`: explicit missing context, assumptions, or policy gaps. Do not fabricate a complete review when scope is incomplete.

The schema intentionally contains no P0/P1/P2, CVSS, or other severity fields. Do not add a severity score to findings.

## Example

This is a synthetic illustration, not a claim about a real codebase, scanner result, or compliance determination:

```json
{
  "schema_version": "2.0.0",
  "review_status": "complete",
  "summary": "One potential data-access issue needs verification.",
  "findings": [
    {
      "id": "HPR-001",
      "alert": "warning",
      "category": "endpoint_access_control",
      "evidence_status": "potential",
      "confidence": "medium",
      "title": "Patient lookup may not enforce requester ownership",
      "location": {
        "path": "src/patients/lookup.ts",
        "start_line": 42,
        "end_line": 45
      },
      "evidence": "The changed lookup uses the request's record identifier; no ownership check is visible in the supplied handler or called function.",
      "risk": "If no upstream authorization check exists, an unauthorized caller may retrieve another patient's health information.",
      "recommendation": "Verify upstream enforcement, add record-level authorization at this boundary, and test cross-patient access.",
      "human_verification_required": true
    }
  ],
  "uncertainties": [
    "Confirm whether an upstream gateway enforces record-level authorization."
  ]
}
```