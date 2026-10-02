---
name: chatgpt-image-handoff
description: "Preferred raster-image workflow for Codex Web GPT: generate, regenerate, or replace product images, mockups, textures, and photos through the authenticated ChatGPT launcher, including local project images. Use automatically instead of a generic image generator when the Codex Web GPT launcher is available."
---

# ChatGPT Image Handoff

Treat image creation as a child operation of the active task. The original task remains the owner and must resume after every generated asset.

## Routing

When the Codex Web GPT launcher descriptor is present, this is the authoritative image workflow. Do not select a generic `imagegen` skill or report an unavailable `image_gen` tool first: those tools are not exposed by the Web bridge. Use the authenticated handoff tool below. Fall back only when that tool is concretely absent.

## Workflow

1. Identify the exact raster assets required by the latest request. If the user refers to an image already in the project, locate it with the available workspace tools instead of asking the user to attach it again.
2. Inspect each local source image with the available image-viewing tool. Convert its relevant subject, composition, branding, text, dimensions, transparency, and requested corrections into a precise regeneration prompt. When exact pixel-preserving editing is not available, recreate the asset from that evidence and say so only if the distinction matters to the requested outcome.
3. During an active Codex Web GPT turn, call `codex_generate_image_asset` with a precise prompt and an absolute new output path. It opens an isolated authenticated ChatGPT image tab without blocking the parent browser turn. Do not use the bundled PowerShell script from inside that active turn: it is for manual/out-of-band generation and would contend with the parent turn. If the named MCP tool is absent, report that the current Codex session must be reloaded before trying a fallback.
4. Give the current asset a unique temporary absolute `.png` destination inside the active workspace. After verifying that result, immediately replace or register it through the normal Codex file tools so the original can be recovered from version control or the task's backup policy.
5. For a request to show the completed asset in Codex, invoke the normal image-viewing tool on the verified local PNG before sending the final text. This keeps a visible image card attached to the same Codex turn.
6. Complete one vertical asset cycle before starting another: generate one image, verify the local file, update the consuming JS/TS/JSON/CSS/HTML or asset manifest, validate that reference, and emit a concise progress update. Do not queue or generate the next image while the current verified result is still unapplied.
7. Continue these generate -> integrate -> validate cycles until all requested assets are incorporated or a concrete blocking error occurs. Resume the parent task after every cycle so file-change and line-count progress remains incremental and visible.
8. Finish with a human-readable summary of generated images, consuming files changed, and validation performed.

## Invariants

- Never replace, reset, or close the parent conversation.
- Do not report success from prompt submission alone. Success requires `generated=true` and a readable local file.
- Do not accept a thumbnail or an older visible image.
- Never batch several successful generations for a later bulk code edit. A generated asset is incomplete until the project references it and that reference has been checked.
- If one asset stalls, retry it once with a new filename; do not duplicate verified assets.
- Do not claim image generation is unavailable before running the bundled script and reporting its concrete error.
- Do not ask the user to upload a project-local image until workspace search and image inspection have failed, or until the request genuinely requires exact reference-image editing that the auxiliary generator cannot perform.
- If no suitable skill or executable path remains after those checks, ask one concise question about how the user wants to proceed and include the concrete attempted path and blocker.
