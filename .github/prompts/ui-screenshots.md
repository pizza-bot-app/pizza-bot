## UI screenshots

Two copies of the web app are running, each with an empty data folder and no
model provider configured:

- after: the pull request's head, at http://localhost:5173
- before: its merge base, at http://localhost:5174

Screenshot UI changes when the diff touches `apps/web`, or when you are asked to:

1. From the diff, work out what a reviewer needs to see: a new view, a reworked
   dialog, a dropdown's new options, a changed empty state. Put each one in the
   state that shows the change, such as a menu open, a dialog up, or a tab
   selected.
2. Use the `playwright` MCP tools to bring both apps to the same state. Save
   each pair with `browser_take_screenshot`, using the filenames
   `.ui-shots/before-<view>.png` and `.ui-shots/after-<view>.png`; the
   directory must be part of the filename. `<view>` is lowercase letters,
   digits, and hyphens, at most 40 characters. Something that exists only in
   the head gets only an `after-` shot. Capture at most six views.
3. Write `.ui-shots/captions.json`, a JSON object mapping each `<view>` to one
   plain sentence describing what changed.

The screenshots are posted to the pull request automatically, so do not attach,
upload, or link them yourself. Never enter credentials or personal data into
either app.
