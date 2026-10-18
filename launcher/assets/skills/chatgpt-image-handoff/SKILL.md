---
name: chatgpt-image-handoff
description: "Use when the executing model is a Codex Web GPT model and needs generated or edited raster assets, including project images, approved-concept game packs, pixel-art sprites, spritesheets and tilesheets, and an authenticated ChatGPT image handoff may be available."
---

# ChatGPT Image Handoff

Treat image creation as a child operation of the active task. The original task remains the owner and must resume after every generated asset.

## Routing

Only prefer this handoff when the executing model is a Codex Web GPT model, as established by the current task/model context. A launcher descriptor or installed skill alone does not establish that the executing model is Web. For native models or when the executing model cannot be verified, preserve the default `imagegen` workflow and its exposed tools. Do not switch a native task to the Web handoff merely because the launcher or this skill is installed.

For a verified Web model, choose a route by its capabilities. Discover the tools actually exposed in the current session. Prefer the authenticated Web handoff when its capabilities meet the request. Do not assume every Web session exposes the same image tools.

Inspect local references before choosing the route. The `codex_generate_image_asset` contract accepts `prompt`, `output_path` and `turn_token`, plus optional `output_options` for final local output controls and optional `reference_image_paths` for real file attachments to the isolated image conversation. Check that the exposed tool schema supports references before using that parameter. A filename in prompt text and viewing an image in the parent chat do not deliver its pixels to an isolated image conversation. When the exposed handoff lacks reference support, use an exposed reference-capable image tool under the `imagegen` skill if available. Do not silently substitute text reconstruction for exact fidelity. Report a concrete capability gap if no suitable route exists.

Use only authoritative active-turn tokens supplied by the runtime; never fabricate or extract unrelated credentials. Do not invoke the bundled out-of-band PowerShell script during an active Web turn or run it merely to satisfy an availability check. Missing tools/capabilities permit another exposed suitable image route; reloading the session is not a mandatory precondition for a working fallback. CLI/API generation remains subject to its explicit authorization and credential requirements.

If an MCP/tunnel SSE probe returns 429, treat it as a transport failure before the generator, not a generation result. Do not infer image-generation quota exhaustion or an API key requirement from that probe. Retry once only after a meaningful state change, such as restored tunnel connectivity or a successful health probe; a new filename or unchanged repeat is not a state change. Preserve the parent conversation and report the transport blocker if recovery is unavailable or the retry fails. This transport recovery rule takes precedence over the stalled-asset retry below.

## Optional reference images

Inspect each actual reference image with the available image-viewing tool before generation. Pass absolute, readable workspace paths in `reference_image_paths`: at most 5 images, PNG, JPEG or WebP, 20 MiB each. These are real file attachments uploaded to the auxiliary image conversation, not path text appended to the prompt. Never claim that a text path transmits pixels. Describe the inspected appearance and requested changes in the prompt; attachment conditioning does not guarantee exact identity or design fidelity. Inspect the generated candidate against the actual references before acceptance.

```json
{
  "prompt": "Use the attached tree reference for silhouette and colors; produce an isolated sprite",
  "output_path": "D:/project/assets/tree.png",
  "turn_token": "<active-turn-token>",
  "reference_image_paths": ["D:/project/references/tree.png"]
}
```

The equivalent `referenceImagePaths` field belongs to the launcher API request at `/v1/image/generate`. The bundled PowerShell helper accepts optional `[string[]]$ReferenceImagePaths` and forwards the actual paths as that JSON array. Outside an active Web turn, an example invocation is:

```powershell
& ./scripts/generate-image.ps1 -Prompt 'Use the attached tree reference for silhouette and colors' -OutputPath 'D:/project/assets/tree.png' -ReferenceImagePaths @('D:/project/references/tree.png')
```

Omit the parameter for prompt-only generation. Reference attachments and `output_options` may be used together; local output controls do not improve reference fidelity.

## Optional final output controls

Use `output_options` only when the asset contract needs final size, a color limit or binary alpha. Example call (replace the token with the authoritative runtime value):

```json
{
  "prompt": "A readable pixel-art tree sprite, isolated on transparent background",
  "output_path": "D:/project/assets/tree.png",
  "turn_token": "<active-turn-token>",
  "output_options": { "width": 32, "height": 32, "max_colors": 16, "binary_alpha": true }
}
```

All controls are optional except that `width` and `height` must be supplied together. Dimensions are integers from 1 to 2048 inclusive; `max_colors` accepts integers from 2 to 256 inclusive and limits distinct visible RGB colors (pixels with alpha greater than zero). `binary_alpha` is a boolean. Dimensions alone, `max_colors` alone or `binary_alpha` alone are valid; `output_options: {}` is invalid. Omitting `output_options` preserves legacy behavior and does not opt into post-processing.

These controls perform deterministic local post-processing after Web generation. Supplied dimensions use contain sizing to preserve aspect ratio with transparent padding and nearest-neighbor resampling. Supplied `max_colors` applies palette reduction without dithering. When `binary_alpha` is true, alpha below 128 becomes 0 and alpha 128 or above becomes 255. Omitted controls do not request their corresponding transformation. A 32 by 32 result does not mean the model generates native 32-pixel artwork. No fixed palette or shared color palette is supported.

With output options, the original candidate is saved as a `*.source.png` sidecar beside the final PNG (for example, `tree.source.png`). The result returns `source_path`, `source_width` and `source_height` for that original, plus `output_options`, `color_count` (distinct visible RGB colors) and `binary_alpha` metadata for the final output. Inspect the final file and retain the sidecar for comparison or recovery.

The final PNG has the exact requested dimensions, obeys the requested color limit and has binary alpha when enabled. These are file constraints: pixel readability still requires visual QA, and post-processing does not promise exact design fidelity. Validate the final asset's silhouette, details, grid and intended consumer before acceptance.

## Game asset production

For pixel-art packs, spritesheets and tilesheets, read `C:/Users/jovipds/.codex/knowledge/game-asset-production-guidelines.md`. Freeze the production contract before generation: reference appearance, native pixel size, grid/spacing, real alpha, family/pose or tile inventory, perspective, scale, anchors and engine/version. An approved labeled board is an appearance reference, not a ready spritesheet. Exclude titles, pose labels, borders and background mockups from production textures.

Generate coherent families rather than one giant mixed board. Validate dimensions/grid/occupied frames/alpha before acceptance; use `scripts/validate-pixel-asset.py --help` for the read-only structural checker. Validate actual motion and compatible tile joins separately. Repeated identical frames are holds, not new animation. A generated PNG is file delivery, not proof of pack readiness.

Delegate independent inventory/metadata/tooling or immutable-candidate QA while the coordinator owns generation/imports. Keep shared style contracts and output ownership explicit; do not run competing image requests on the same active token/session. Keep scope precise: a request to improve rules does not itself require generating a new asset pack.

## Workflow

1. Identify the exact raster assets required by the latest request. If the user refers to an image already in the project, locate it with the available workspace tools instead of asking the user to attach it again.
2. Inspect each local source image with the available image-viewing tool. Separate appearance invariants from presentation-only text/layout. Supply actual reference input when supported; otherwise identify the result as text reconstruction when the distinction matters. Form a precise production prompt.
3. Use the selected supported route. For the Web handoff, call the exposed `codex_generate_image_asset` with a precise prompt, authoritative active token and new absolute output path; attach inspected local references through `reference_image_paths` when supported and add `output_options` only for requested final output controls described above. Preserve the parent conversation. For a reference-capable fallback, follow its actual schema and skill rather than inventing handoff parameters.
4. Save the candidate non-destructively in the active workspace. Inspect the returned file and validate the asset contract before replacing or registering it. Keep originals recoverable. Reject/correct a bad candidate before integration; never wire it in simply because generation succeeded.
5. For a request to show the completed asset in Codex, invoke the normal image-viewing tool on the verified local PNG before sending the final text. This keeps a visible image card attached to the same Codex turn.
6. Complete one vertical asset cycle before starting another: generate, validate the production contract, update the actual consumer or pack manifest, validate that reference, and report concise progress. Godot consumers include version-compatible sprite/animation/TileSet resources; web assets use their existing consumer. Pack-only requests need usable assets/metadata, not unsolicited gameplay changes. Continue independent preparation/QA in parallel, without competing generator/import control.
7. Continue these generate -> integrate -> validate cycles until all requested assets are incorporated or a concrete blocking error occurs. Resume the parent task after every cycle so file-change and line-count progress remains incremental and visible.
8. Finish with a human-readable summary of generated images, consuming files changed, and validation performed.

## Invariants

- Never replace, reset, or close the parent conversation.
- Do not report success from prompt submission alone. Web handoff delivery requires `generated=true` and a readable local file; other tools require their actual success result. Production acceptance also requires the relevant asset checks.
- Do not accept a thumbnail or an older visible image.
- Never accumulate passing generations for a later bulk integration. A requested production asset is incomplete until the game consumer or requested pack manifest references it and that reference has been checked.
- If one asset stalls, retry it once with a new filename; do not duplicate verified assets.
- Do not claim universal image-generation unavailability from one missing tool. Check exposed suitable routes and report the actual failed capability/action. Do not force an unsafe or unauthorized fallback.
- Do not ask the user to upload a project-local image until workspace search and image inspection have failed, or until the request genuinely requires exact reference-image editing that the auxiliary generator cannot perform.
- If no suitable skill or executable path remains after those checks, ask one concise question about how the user wants to proceed and include the concrete attempted path and blocker.
