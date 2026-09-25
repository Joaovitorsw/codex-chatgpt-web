---
name: chatgpt-image-handoff
description: Automatically generate, regenerate, or replace raster assets needed by a Codex task in an authenticated auxiliary ChatGPT image turn, including when the source image is already in the local project. Use for product photos, website imagery, mockups, textures, image corrections, and multi-asset goals without requiring the user to name this skill; do not use for SVG or code-native graphics.
---

# ChatGPT Image Handoff

Treat image creation as a child operation of the active task. The original task remains the owner and must resume after every generated asset.

## Workflow

1. Identify the exact raster assets required by the latest request. If the user refers to an image already in the project, locate it with the available workspace tools instead of asking the user to attach it again.
2. Inspect each local source image with the available image-viewing tool. Convert its relevant subject, composition, branding, text, dimensions, transparency, and requested corrections into a precise regeneration prompt. When exact pixel-preserving editing is not available, recreate the asset from that evidence and say so only if the distinction matters to the requested outcome.
3. Run `scripts/generate-image.ps1` from this skill directory with `-Prompt` and an absolute new `-OutputPath`. It opens an authenticated auxiliary ChatGPT Web conversation and returns a verified PNG. Do not search the outer Codex tool catalog for `codex_generate_image_asset`; that tool belongs to the inner ChatGPT connector.
4. Give the current asset a unique temporary absolute `.png` destination inside the active workspace. After verifying that result, immediately replace or register it through the normal Codex file tools so the original can be recovered from version control or the task's backup policy.
5. Complete one vertical asset cycle before starting another: generate one image, verify the local file, update the consuming JS/TS/JSON/CSS/HTML or asset manifest, validate that reference, and emit a concise progress update. Do not queue or generate the next image while the current verified result is still unapplied.
6. Continue these generate -> integrate -> validate cycles until all requested assets are incorporated or a concrete blocking error occurs. Resume the parent task after every cycle so file-change and line-count progress remains incremental and visible.
7. Finish with a human-readable summary of generated images, consuming files changed, and validation performed.

## Invariants

- Never replace, reset, or close the parent conversation.
- Do not report success from prompt submission alone. Success requires `generated=true` and a readable local file.
- Do not accept a thumbnail or an older visible image.
- Never batch several successful generations for a later bulk code edit. A generated asset is incomplete until the project references it and that reference has been checked.
- If one asset stalls, retry it once with a new filename; do not duplicate verified assets.
- Do not claim image generation is unavailable before running the bundled script and reporting its concrete error.
- Do not ask the user to upload a project-local image until workspace search and image inspection have failed, or until the request genuinely requires exact reference-image editing that the auxiliary generator cannot perform.
- If no suitable skill or executable path remains after those checks, ask one concise question about how the user wants to proceed and include the concrete attempted path and blocker.
