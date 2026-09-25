# Validation and handoff

Choose checks from the changed behavior and risk, not from habit.

- Run focused unit or contract tests for the modified boundary.
- Run type checking, linting, or build checks when the changed language or package uses them.
- Exercise the user-visible flow for lifecycle, UI, browser, installer, or packaging changes.
- Inspect the final diff for accidental rewrites, secrets, generated artifacts, stale version markers, and unrelated files.
- Confirm negative behavior: failures remain safe, retries do not duplicate effects, and existing user data is preserved.

Finish with an outcome-first summary that names material files or components, describes observable behavior, lists validation performed, and states any remaining limitation precisely. Do not finish on a progress note or future-tense promise.
