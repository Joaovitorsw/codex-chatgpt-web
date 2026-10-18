---
name: chatgpt-image-handoff
description: "Use when the executing model is a Codex Web GPT model and needs generated or edited raster assets, including project images, approved-concept game packs, pixel-art sprites, spritesheets and tilesheets, and an authenticated ChatGPT image handoff may be available."
---

# ChatGPT Image Handoff

Treat image creation as a child operation of the active task. The original task remains the owner and must resume after every generated asset.

## Routing

Only prefer this handoff when the executing model is a Codex Web GPT model, as established by the current task/model context. A launcher descriptor or installed skill alone does not establish that the executing model is Web. For native models or when the executing model cannot be verified, preserve the default `imagegen` workflow and its exposed tools. Do not switch a native task to the Web handoff merely because the launcher or this skill is installed.

For a verified Web model, choose a route by its capabilities. Discover the tools actually exposed in the current session. Prefer the authenticated Web handoff when its capabilities meet the request. Do not assume every Web session exposes the same image tools.

Inspect local references before choosing the route. The observed `codex_generate_image_asset` contract accepts only `prompt`, `output_path` and `turn_token`: it does not transport image attachments. A filename in prompt text and viewing an image in the parent chat do not deliver its pixels to an isolated image conversation. When actual reference conditioning/editing is needed, use an exposed reference-capable image tool under the `imagegen` skill if available. Do not silently substitute text reconstruction for exact fidelity. Report a concrete capability gap if no suitable route exists.

Use only authoritative active-turn tokens supplied by the runtime; never fabricate or extract unrelated credentials. Do not invoke the bundled out-of-band PowerShell script during an active Web turn or run it merely to satisfy an availability check. Missing tools/capabilities permit another exposed suitable image route; reloading the session is not a mandatory precondition for a working fallback. CLI/API generation remains subject to its explicit authorization and credential requirements.

If an MCP/tunnel SSE probe returns 429, treat it as a transport failure before the generator, not a generation result. Do not infer image-generation quota exhaustion or an API key requirement from that probe. Retry once only after a meaningful state change, such as restored tunnel connectivity or a successful health probe; a new filename or unchanged repeat is not a state change. Preserve the parent conversation and report the transport blocker if recovery is unavailable or the retry fails. This transport recovery rule takes precedence over the stalled-asset retry below.

## Game asset production

For pixel-art packs, spritesheets and tilesheets, read `C:/Users/jovipds/.codex/knowledge/game-asset-production-guidelines.md`. Freeze the production contract before generation: reference appearance, native pixel size, grid/spacing, real alpha, family/pose or tile inventory, perspective, scale, anchors and engine/version. An approved labeled board is an appearance reference, not a ready spritesheet. Exclude titles, pose labels, borders and background mockups from production textures.

Generate coherent families rather than one giant mixed board. Validate dimensions/grid/occupied frames/alpha before acceptance; use `scripts/validate-pixel-asset.py --help` for the read-only structural checker. Validate actual motion and compatible tile joins separately. Repeated identical frames are holds, not new animation. A generated PNG is file delivery, not proof of pack readiness.

Delegate independent inventory/metadata/tooling or immutable-candidate QA while the coordinator owns generation/imports. Keep shared style contracts and output ownership explicit; do not run competing image requests on the same active token/session. Keep scope precise: a request to improve rules does not itself require generating a new asset pack.

## Workflow

1. Identify the exact raster assets required by the latest request. If the user refers to an image already in the project, locate it with the available workspace tools instead of asking the user to attach it again.
2. Inspect each local source image with the available image-viewing tool. Separate appearance invariants from presentation-only text/layout. Supply actual reference input when supported; otherwise identify the result as text reconstruction when the distinction matters. Form a precise production prompt.
3. Use the selected supported route. For the Web handoff, call the exposed `codex_generate_image_asset` with a precise prompt, authoritative active token and new absolute output path. Preserve the parent conversation. For a reference-capable fallback, follow its actual schema and skill rather than inventing handoff parameters.
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
