# Bot activity hints implementation plan

> **For agentic workers:** Implement inline using superpowers:executing-plans. The user approved the in-chat interaction and asked for implementation; do not request another design approval.

**Goal:** Render truthful, persistent, avatar-led activity hints with restrained one-shot motion.

**Architecture:** A validated activity record is stored as a system message. A shared renderer powers the conversation and an isolated lab preview. Existing API acknowledgements drive chat/reminder transitions; future membership/handoff producers use the same contract.

**Tech Stack:** Native ES modules, layered SVG and CSS. No dependencies.

**Spec:** `docs/bot-activity.md`.

## Global Constraints

- No full test suite, real model requests, or login validation; final effects are checked by the user.
- No fake production joins/handoffs. No additional API calls for status messages.
- Persist terminal statuses; restore unresolved pending statuses as unknown.
- Honor motion preferences; never replay historical event motion.

## Review Focus

- Repeated receipts must update one event, not duplicate it.
- Failed API calls must never display saved/completed acknowledgements.
- Corrupt persisted events and names containing markup must be rejected or escaped.
- Background polling must not generate repeated reminder confirmation rows.
- Active typing, history grouping, channel switching and search must still work around event rows.

## Tasks

- [x] Add `tests/activity.test.mjs` covering deduplication, persistence, invalid records and real chat success/failure transitions; observe failure before implementation.
- [x] Add `web/js/services/activity.js`, extend store persistence and add shared `web/js/ui/activity.js` rendering.
- [x] Integrate with transcript append/patch/grouping and scoped CSS for one-shot/reduced motion.
- [x] Wire chat requests and explicit reminder API receipts; exclude system events from model history.
- [x] Add clearly marked local preview to `lab.html` with joined/handoff/progress/success/failure and motion controls.
- [x] Run only the new offline test file, syntax and diff checks; inspect code for the review focus above and document user acceptance steps.

## Execution notes

- Worktree: `bot-activity-hints`; branch `codex/bot-activity-hints`, based on `fd6b119`.
- Ruling: keep membership/handoff as an explicit producer contract and lab preview because the current service has no real multi-bot lifecycle. Faking membership would violate the approved truthfulness requirement.
- Fixed a polling/receipt race: only the displayed activity revision deduplicates acknowledgements, not the locally synchronized reminder state. Backend receipts include create/update operation metadata.
- Verification: `node --test tests/activity.test.mjs` passed 10/10; JavaScript syntax checked for 7 changed/new modules and Python `ast.parse` for `scripts/notice_ai/chat.py`; `git diff --check` clean. Full tests, browser/runtime validation and real API calls intentionally omitted at user request.
- A separate read-only static reviewer checked persistence, grouping, history filtering, timers and reduced motion. Fixed its image-avatar handoff selector finding by distinguishing sender and recipient. Visual effect remains for user acceptance.
