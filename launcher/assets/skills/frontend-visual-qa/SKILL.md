---
name: frontend-visual-qa
description: Implement and refine substantial frontend UI work with consistent cards, media, icons, typography, spacing, and responsive behavior. Use automatically for frontend coding and visual-polish tasks; prioritize concrete source edits and bounded validation over prolonged UI automation.
---

# Frontend Visual QA

Make the interface feel deliberately designed without imposing a generic visual style. Preserve the user's requested aesthetic and the project's existing design system. Work code-first: visual tools verify an implementation; they do not replace it.

## Execute code first

1. Inspect only the relevant components, styles, tokens, and existing tests needed to form the first implementation.
2. Apply an initial coherent source edit promptly. For large requests, start with high-leverage shared tokens, layout primitives, or reusable components.
3. Continue in small functional batches so progress and line changes become visible while the task runs.
4. Run fast source-level checks before opening a visual surface.
5. Use one focused rendered check after meaningful code changes, then fix only defects supported by that evidence.

Do not use Windows window management for this workflow. If visual evidence is necessary, use the existing browser page or its DevTools only to confirm concrete risks such as clipping, overflow, broken sizing, or responsive layout. Do not reopen, resize, or refocus the same surface without a concrete reason.

## Inspect efficiently

- Inspect the reusable components, CSS architecture, tokens, and breakpoints before choosing dimensions. Inspect the rendered UI first only when the task depends on an unknown current visual state.
- Identify repeated visual patterns and test them with the shortest, longest, missing, and unexpected content.
- Reuse existing primitives and tokens before adding one-off values.

## Build consistent component geometry

- Prefer Grid or Flexbox stretching, shared component regions, and content-aware layout over arbitrary fixed heights.
- For repeated cards, align media, title, body, metadata, and actions consistently. Add `min-height` only when it improves rhythm without clipping at narrow breakpoints.
- Do not truncate meaningful text merely to make cards equal. Use line clamping only when the product allows hidden text and provides a way to access it when necessary.
- Give repeated media a shared `aspect-ratio`, predictable container, suitable `object-fit`, and intentional focal positioning. Reserve space to prevent layout shift and define a graceful fallback.
- Keep controls in a repeated row aligned even when the content above them has different lengths.

## Tune the visual system

- Use a small, coherent spacing and type scale. Prefer existing CSS variables; introduce semantic tokens when repetition justifies them.
- Set readable line lengths and line heights. Use responsive sizing such as `clamp()` when it improves hierarchy, but do not shrink important text simply to make it fit.
- Keep icons from one visual family when possible. Normalize icon box, optical size, stroke weight, and alignment; distinguish the visible icon size from the button's larger interaction target.
- Give buttons and inputs consistent heights, padding, labels, hover, focus-visible, disabled, loading, and error states.
- Preserve contrast, keyboard access, reduced-motion preferences, and semantic markup while polishing the visuals.

## Verify quickly without looping

- Use the cheapest reliable validation for the change. A focused component check is enough when the edit does not require a full application tour.
- Use the browser or DevTools primarily to check that the changed element is visible, not clipped, not overflowing, and behaves at the relevant breakpoint. Do not tour unrelated pages or states.
- Perform one visual pass by default. Allow a second pass only when the first reveals a concrete defect that was then changed in source. Stop after that unless the user explicitly requested a visual audit.
- Never repeat identical inspection or UI actions hoping for a different result. If the visual surface is unavailable or unstable, rely on source/build checks and state the remaining uncertainty.
- Run the relevant build, type checks, tests, or lint checks in proportion to the change.
- Do not perform exhaustive responsive, accessibility, or cross-page auditing unless the request calls for it or the edit creates a specific risk.

## Communicate progress and completion

- For substantial edits, provide short, meaningful progress updates after each coherent source-edit batch and validation stage.
- Finish with a human summary of the visible improvements, the principal files changed, and the validation performed.
- State any remaining visual uncertainty explicitly when the interface could not be rendered.
