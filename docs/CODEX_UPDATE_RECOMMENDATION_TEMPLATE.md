# Codex Update Recommendation Template

Use this exact structure when reviewing available updates for this repo.

Keep the writing plain and short.
Do not recommend production upgrades just because a newer version exists.
Always use the local audit output first, then research official vendor sources before recommending action.

## Required workflow

1. Run:

```bash
bash scripts/run-update-review.sh
```

2. For each available update, research:
   - official changelog
   - official release notes
   - official migration guide if one exists
   - official security advisory if one exists

3. Then answer in this format:

## Available updates

- `<package>` from `<current>` to `<latest>`

## Why they matter

- Explain the practical reason this update might matter to this app.

## Risks

- Explain what could break, with special caution for payments, auth, config loading, and runtime behavior.

## Recommendation

- `update now`
- `safe to wait`
- `test in staging first`
- `do not touch production yet`

Use one of those labels for each update and explain why in one or two sentences.

## Next step

- Give the next action a human should take.
- Examples:
  - `leave production alone and review again next week`
  - `stage stripe 22.0.1 and run the live Stripe drills`
  - `wait for a clearer upstream fix or changelog`

## Extra rules

- Stripe SDK updates are never auto-approved for production.
- Stripe API version changes and webhook version changes must be treated separately from package updates.
- If the research is unclear, default to `safe to wait` unless there is a security or deprecation reason to move faster.
- If an update is urgent for security, say that explicitly and cite the official source.
