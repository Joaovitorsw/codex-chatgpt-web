# Implementation

Use this route for features, refactors, backend work, integrations, and multi-file changes.

1. Locate the existing entrypoint, data flow, configuration boundary, and closest tests before choosing a design.
2. Reuse established types, helpers, lifecycle ownership, and error conventions. Add a new abstraction only when it removes real duplication or isolates a stable responsibility.
3. Implement in coherent vertical slices so behavior and tests advance together. Keep public interfaces narrow and preserve backward compatibility unless the request explicitly changes it.
4. Handle failure and rollback at the boundary that owns the mutation. Preserve user data and unrelated configuration.
5. Prefer deterministic behavior and explicit state over hidden global coupling, duplicated caches, or timing-based coordination.

For performance work, measure or identify the actual bottleneck before introducing concurrency, caching, workers, or hardware-specific paths. Keep the simpler path when the expected gain is not material.
