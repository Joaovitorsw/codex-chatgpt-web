---
name: code-task-presentation
description: Present implementation and file-editing tasks with useful live progress, portable Markdown, clear changed-file reporting, and a verified human conclusion. Use for substantial coding work; do not activate for short explanatory answers with no repository changes.
---

# Code Task Presentation

Keep the user informed without narrating private reasoning.

- Before the first tool call, state the immediate outcome and first concrete phase in one short paragraph.
- During code changes, prefer frequent concise updates after each completed vertical slice, meaningful edit batch, or small group of tool calls. Name what was learned, changed, or validated so the user sees continuous real progress instead of a long silent interval.
- Prefer smaller coherent edit batches that let native file-change and line-count reporting advance incrementally. Only group work into a larger silent operation when correctness genuinely requires the change to be atomic; do not split an indivisible edit or manufacture filler merely to create activity.
- Use portable Markdown. Put directory trees, multiline commands, logs, and code in fenced blocks with a suitable language identifier. Never reproduce interface labels such as `Plain text`, `Copy`, or `Show more` as content.
- Present changed files and validations as concise lists when there is more than one item. Preserve meaningful line breaks in trees and command output.
- Finish only after required tool results settle. Lead with the achieved outcome, name material files changed, summarize the important behavior, and state how it was validated. If something remains, identify the exact deliverable and blocker.
