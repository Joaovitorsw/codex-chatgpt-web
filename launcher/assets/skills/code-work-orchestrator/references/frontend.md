# Frontend

Use this route for React, HTML/CSS, interface behavior, accessibility, and responsive work.

1. Preserve the project's component, styling, state, and design-token conventions. Avoid rewriting stable structure solely for visual novelty.
2. Model loading, empty, error, disabled, active, and completion states explicitly when the interaction can reach them.
3. Keep keyboard behavior, focus, labels, contrast, reduced motion, and responsive layout intact.
4. Prefer semantic markup and component state over DOM text scraping, fixed delays, or visual-position assumptions.
5. Validate the actual rendered interaction at representative viewport sizes when visual tooling is available; otherwise test the state and markup contracts and clearly identify the remaining visual check.

For streamed or asynchronous UI, separate partial progress from terminal output and do not mark a task idle while any owned operation, response, or finalization step remains active.
