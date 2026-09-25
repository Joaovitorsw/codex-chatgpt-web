---
name: code-work-orchestrator
description: Automatically route substantial repository investigation, bug fixing, feature implementation, refactoring, frontend work, and validation to a focused code workflow. Use for code changes or diagnosis without requiring the user to name this skill; skip for tiny obvious edits and answers that require no repository work.
---

# Code Work Orchestrator

Choose the smallest workflow that can complete the request correctly. Do not load every reference.

## Route

- For a bug, regression, crash, or unexplained behavior, read [references/diagnosis.md](references/diagnosis.md).
- For a feature, refactor, backend change, integration, or multi-file implementation, read [references/implementation.md](references/implementation.md).
- For React, HTML/CSS, UI behavior, accessibility, responsive layout, or visual code, also read [references/frontend.md](references/frontend.md).
- When the change is risky, touches behavior, or needs a handoff, read [references/validation.md](references/validation.md) before finishing.

An obvious localized edit may be performed directly without reading a reference. Combine routes only when the request genuinely spans them.

## Shared decisions

1. Treat repository instructions and the latest user request as authoritative. Preserve existing architecture and unrelated changes.
2. Retrieve context progressively: begin with task-focused code search, symbols, callers, tests, and narrow ranges. Avoid broad trees and whole-file reads when targeted retrieval is sufficient.
3. Form a concrete implementation hypothesis from evidence, then edit the smallest coherent surface. Prefer existing abstractions over parallel replacements.
4. Implement in small coherent vertical slices and report concise, concrete progress after each slice or meaningful tool batch. Prefer more real checkpoints during code changes so edits and validation become visible incrementally; group them only when correctness genuinely requires an atomic operation. Do not fragment indivisible work or add ceremony to simple tasks.
5. Validate in proportion to risk and inspect the final diff. Do not claim completion from a successful command alone when the requested behavior can be checked directly.

If no available workflow or tool can perform a required operation after discovery and one supported attempt, state the exact blocker and ask one concise question about the user's preferred fallback.
