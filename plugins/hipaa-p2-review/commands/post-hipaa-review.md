---
name: post-hipaa-review
description: Post an existing healthcare review result as a PR comment after human approval. Usage: /post-hipaa-review <pr-number> [result.json]
argument-hint: <pr-number> [result.json]
disable-model-invocation: true
---

Post a saved healthcare privacy and access review result to a pull request. Arguments: $ARGUMENTS

1. The first argument is `PR_NUMBER` and must be a positive integer; if it is missing, ask for it. The second argument is the result path; default to `/tmp/hipaa-p2-review/review-result.json`. If the file does not exist, stop and suggest running `/hipaa-review` first.
2. If `/tmp/hipaa-p2-review/plugin.env` does not exist, run step 0 of the `/hipaa-review` command (`commands/hipaa-review.md` in this plugin) to resolve the plugin root.
3. Follow `$HIPAA_PLUGIN_ROOT/references/pr-comment-publishing.md` from step 1 (render the dry run) through step 4 (post), using the given result path. Do not change the result file.
4. End with the script's result line, or with the reason nothing was posted.
