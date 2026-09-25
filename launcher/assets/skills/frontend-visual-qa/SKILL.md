---
name: frontend-visual-qa
description: Refine and validate substantial frontend UI work when visual consistency, repeated cards, media sizing, icon scale, typography, spacing, responsive behavior, or rendered quality matters. Use automatically for frontend implementation and visual-polish tasks; do not use for backend-only work or tiny isolated CSS questions.
---

# Frontend Visual QA

Make the interface feel deliberately designed without imposing a generic visual style. Preserve the user's requested aesthetic and the project's existing design system.

## Inspect before changing

- Inspect the rendered UI, reusable components, CSS architecture, tokens, and breakpoints before choosing dimensions.
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

## Verify the real interface

1. Render the actual page whenever preview or browser tools are available; do not infer visual quality from source alone.
2. Check narrow mobile, intermediate, and wide desktop widths, plus wrapping, overflow, zoom, and dynamic content.
3. Compare repeated components side by side for aligned media, text, actions, and baselines.
4. Check image loading failures, empty states, long localized copy, focus order, and visible focus.
5. Run the relevant build, type checks, tests, and lint checks after visual validation.
6. Iterate on concrete rendered defects rather than declaring success after the first pass.

## Communicate progress and completion

- For substantial edits, provide short, meaningful progress updates after inspection and after each coherent implementation or validation stage.
- Finish with a human summary of the visible improvements, the principal files changed, and the validation performed.
- State any remaining visual uncertainty explicitly when the interface could not be rendered.
