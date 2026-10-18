# Existing images in final Web responses

`codex_view_image` returns the image and a turn-scoped `image_ref`. A Web model can include that exact image in its final answer by putting `CODEXIMAGE:<sha256>` as plain text on its own line. After browser completion, the adapter resolves the reference using the bytes registered by the MCP handler and emits Markdown containing a `data:image/...;base64,...` URL in `output_text` with `phase: final_answer`. The marker must not be put inside a Markdown image URL: a live test showed ChatGPT removes the unsupported custom URL before DOM extraction.

The model does not generate or transcribe Base64. Inspection alone does not present an image. References from another turn, expired references, excessive repetitions, and excessive expanded output fail explicitly. Workspace containment uses canonical paths. Generated images outside the current workspace remain inspectable under the existing policy but are not registered for final presentation.

Completed media is captured before capability retirement and included in the reconnect journal. Compiled assistant history summarizes already-delivered image bytes so subsequent Web prompts do not resend Base64 as prose. PNG, JPEG, WebP and GIF87a/GIF89a use the same delivery path. GIF bytes are not decoded, flattened or transcoded: frame data, delays, loop and disposal remain byte-identical. A tool preview may show a static frame; it does not establish final animation playback.

For GIFs, the MCP tool result contains a compact text receipt with `image_ref`, not a GIF image content block. A live external connector test returned no usable output when the tool result included the animated GIF image block. The original bytes remain registered in the owning broker and are expanded only in the final answer. Receipt-only output is successful registration; the model must return the marker rather than treating the missing tool preview as a display failure.

The local viewer accepts files up to 12 MiB. Oversized files fail explicitly without modification. A separately prepared smaller preview can be presented within this bound; the bridge does not automatically resize the original. References are only registered for authorized workspace files. A file link or successful inspection without returning the supplied marker does not deliver final media.

## Why use final Markdown

Verified against Codex CLI `0.162.0-alpha.17.2` and desktop `26.1007.9446.0` on 2026-10-18:

- Assistant message parsing retains text, not arbitrary image content: [event_mapping.rs](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/core/src/event_mapping.rs#L149).
- Provider `image_generation_call` items do not create the native image extension's completed turn item: [stream_events_utils.rs](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/core/src/stream_events_utils.rs#L467-L482). The extension uses a separate native lifecycle: [tool.rs](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.17.2/codex-rs/ext/image-generation/src/tool.rs#L223-L249).
- The installed desktop webview permits `data:` image sources but blocks plain HTTP in its `img-src` content security policy. Its Markdown URL sanitizer preserves image data URLs. Therefore a loopback HTTP media endpoint does not establish renderer compatibility.

These are version-specific findings, not guarantees about future clients. Raw response persistence, successful protocol tests, and tool previews do not prove that the desktop rendered the final answer.

## Validation

```powershell
bun test tests/final-image-delivery.test.ts tests/final-gif-delivery.test.ts tests/final-gif-mcp.test.ts tests/prompt-contract.test.ts
bun test tests/chatgpt-web-harness.test.ts -t 'delivers a tool-read image|routes native command bridges'
bun run typecheck
bun run scripts/smoke-final-image-relay.ts 'D:/absolute/workspace/existing.png'
bun run scripts/smoke-final-image-relay.ts 'D:/absolute/workspace/animated.gif'
bun run scripts/smoke-final-image-relay.ts 'D:/absolute/workspace/animated.gif' --verify-animation 'C:/absolute/browser/chrome.exe'
```

The smoke command verifies byte identity across actual MCP stdio, the scoped broker, final Markdown, and Responses JSON. With `--verify-animation`, at most three bounded Chromium screenshots sample the delivered GIF data URL. Different samples report `animation_result: observed`, proving playback in an isolated browser fixture with a data-image CSP. Identical samples report `inconclusive`: long frame delays or repeating phases must not be mistaken for corrupt delivery. It explicitly reports `web_model_exercised: false` and does not establish desktop UI rendering. Live acceptance additionally requires a real Web turn returning the reference, an actual persisted final data URL with the source SHA-256, and rendered evidence in the destination conversation. Reuse an existing image; generation is unnecessary.
