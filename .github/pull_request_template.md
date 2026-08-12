<!--
  PR title MUST follow Conventional Commits — it becomes the commit
  subject on main under squash-merge, and release-please uses it to
  decide the next version.

    feat: add X                 → next minor
    fix: correct Y              → next patch
    feat!: drop Z               → next major (or minor while pre-1.0)
    docs: explain W             → no version bump
    chore: …, build: …, ci: …   → no version bump

  Types allowed: feat, fix, perf, refactor, docs, build, ci, chore,
  revert, style, test.
-->

## Summary

<!-- One or two sentences on what changes and why. -->

## Test plan

- [ ] `pnpm lint` clean
- [ ] `pnpm lint:type-aware` clean (a separate gate; `pnpm lint` does not
      include it, and CI runs both)
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` passes
- [ ] New behaviour covered by a test (or explicit "no" with reason)
- [ ] If touching spec loading, routing, or schema compilation:
      `pnpm build`, then `cd conformance && pnpm openapi` clean

## Notes for reviewer

<!-- Anything non-obvious about the approach, trade-offs, or what to
     look at first. Delete if there's nothing. -->
