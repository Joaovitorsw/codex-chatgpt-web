# Diagnosis

Use this route to explain and, when requested, fix a defect.

1. Reproduce or identify the observable failure before editing when practical.
2. Trace from the failing boundary toward the narrowest responsible symbol. Check recent callers, state transitions, error translation, concurrency, and lifecycle ownership relevant to the symptom.
3. Separate the root cause from secondary symptoms. Do not mask the failure with retries, longer timeouts, or fallback behavior unless evidence shows transient timing is the cause.
4. Add or update a regression test that fails for the original behavior and exercises the corrected boundary.
5. Re-run the smallest relevant test first, then broader checks justified by the impact surface.

For intermittent failures, record the event ordering and ownership assumptions. Prefer state-based completion evidence over fixed sleeps.
