# PigeonPal UI Prototype Implementation Plan

> Execution: native implementation in this session, following the user's explicit request to create the approved UI. No dependency installation, external hosting, or DSH integration.

**Goal:** Deliver a working, locally previewable campus companion UI with chat, notification channel, writing examples, saved messages, reminders, and editable identity.

**Architecture:** Buildless HTML, CSS, and ES modules. Pure state helpers manage messages and reminder lifecycles; a browser controller renders views and handles local storage. The independent SVG mascot exposes idle, thinking, and notifying states, with reduced-motion support.

**Spec:** `docs/superpowers/specs/2026-10-13-campus-bot-design.md`

## Constraints

- One identity shared across channels; default name 小浙.
- Fictional notices and canned writing responses are explicitly identified as examples.
- No model calls, live scraping, or promises of reminders after the browser closes.
- Keep the UI calm: transform/opacity interactions, static transcript avatars, optional subtle mascot animation.
- Use only installed tools; no package downloads.

## Files and responsibilities

- `dist/index.html`: application shell and accessible dialog/notification regions.
- `dist/styles.css`: layout, message styling, responsive behavior, and motion settings.
- `dist/assets/pigeon.svg`: original replaceable mascot.
- `dist/state.mjs`: message identity, favourites, reminder state transitions, storage hydration.
- `dist/ui.mjs`: safe markup, icons, avatar and message components.
- `dist/app.mjs`: routing, composer, dialogs, demo responses, and persistence.
- `tests/state.test.mjs`: identity, corrupted storage, rescheduling, completion and duplicate-notification checks.
- `package.json`, `README.md`: local launch and validation commands.

## Task 1 — State model

Interfaces: `createInitialState(now)`, `hydrateState(raw, now)`, `toggleFavorite(state, messageId)`, `addReminder(state, { title, dueAt, messageId }, now)`, `updateReminder(state, id, patch, now)`, `emitReminder(state, id, now)`.

- [ ] Write state tests before implementation. Require an invalid or past date to be rejected, rescheduling to reuse an existing reminder, completion to suppress future delivery, and favourites to reference stable message IDs.
- [ ] Run `node --test tests/state.test.mjs`; confirm missing implementation fails.
- [ ] Implement `dist/state.mjs`; run the same tests and confirm pass.

## Task 2 — Independent UI

- [ ] Create original mascot and application shell. Use a 260px sidebar, restrained blue accent, light incoming bubbles, dark outgoing bubbles, and incoming avatars.
- [ ] Implement chat and campus channel, long-writing expansion and quote context, favourites with jump-to-message, reminder CRUD and preview, settings, nickname and avatar replacement.
- [ ] Show sending/thinking status without tool logs. Batch short user messages; prevent background reply completion from changing the active channel.
- [ ] Persist records safely. Escape user content. Handle unavailable clipboard and storage visibly.
- [ ] Expose avatar states and animation setting; respect `prefers-reduced-motion`; maintain keyboard and touch access to message actions.

## Task 3 — Browser acceptance

- [ ] Serve on loopback and verify HTTP response. Open the local result in Codex.
- [ ] Inspect desktop and narrow-window layouts. Exercise notification details, favourite, writing expansion, reminder edit/snooze/complete, and settings persistence.
- [ ] Check long input and reading-history behavior, confirm no horizontal overflow, and review focus/dialog interactions.
- [ ] Run state tests and syntax checks after the final changes. Record actual results in `work/progress.md`.

## Review focus

1. Repeated reminder previews must not flood the transcript.
2. Rescheduling must retain one active reminder and allow one later delivery.
3. A delayed reply must belong to its originating channel.
4. User strings and imported local records must never become executable markup.
5. Motion-disabled and keyboard users must retain all functionality.
