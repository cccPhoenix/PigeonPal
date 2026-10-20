# PigeonPal 0.3.1 desktop release plan

> **For agentic workers:** Use superpowers:executing-plans to implement the approved desktop packaging request inline.

**Goal:** Deliver current-source macOS arm64 DMG and Windows x64 installer with first-run evidence, and student-facing documentation.
**Architecture:** Existing Electron shell, PyInstaller service, stable local origin and local reminder queue. Use native builds per OS. Add an explicit offline self-check using newly created temporary data; never alter normal users' credentials/data for acceptance.
**Tech Stack:** Electron 44.9.0, Python 3.12, PyInstaller 6.22.3, electron-builder 26.15.3.
**Spec:** User request: installers preserve existing functionality and responsiveness after fresh install; README addresses students. Existing app behavior and docs/desktop.md define background/tray/reminder boundaries.

## Global constraints
- Include latest main (de6497e) and alignment correction, single companion.
- Version 0.3.1; no development credentials or personal data in artifacts.
- Offline reminders work without API; first-run public/protected sources accurately distinguished.
- No signing/notarization or Windows interactive notification claims without evidence.
- Windows workflow permission change requires explicit user authorization (received for initiating browser authorization).
- Preserve primary checkout's untracked videos/ and older mounted-image worktree.

## Review focus
- Empty installation, no account/key/network: UI still works, no blank window.
- Unrelated existing developer data never modified by self-check.
- Frozen import/static resources and TLS certificates complete on each OS.
- Window hide/reopen and backend shutdown do not leak processes/locks.
- README download/build/validation claims match actual produced artifacts.

## Task 1: Package and validate the current desktop app
- [x] Run existing JS/Python suites as a baseline.
- [x] Bump package/lock version to 0.3.1.
- [x] Implement a bounded opt-in offline first-run self-check with disposable data: renderer bootstrap, navigation, profile save, form reminder, reload persistence, hide/show, backend lifecycle and timing report. Add driver and use it against built binaries.
- [x] Strengthen frozen-service smoke for all static resources, empty settings and reminder delivery/restart.
- [ ] Windows handoff: user chose a Windows classmate to build locally; supply prompt and runnable build/smoke scripts. Do not enable workflow or claim exe exists.
- [x] Build macOS DMG; verify image and signatures; run frozen-service and packaged-app checks.
- [ ] Keep report/checksum provenance beside artifacts.

## Task 2: Student delivery and repository integration
- [x] Rewrite README around what it does, downloads, first-use steps, privacy, reminders, troubleshooting; move maintainer detail to docs/desktop.md.
- [x] Review changes once with a fresh code reviewer; fix material findings and rerun relevant checks.
- [ ] Push branch and attach PR; merge authorized release work and sync main after checks.
- [ ] Stage versioned release files/checksums and concise platform-specific evidence. Publish only artifacts actually built; mark signing/real-account/OS notification limits.

## Execution notes
Pre-flight: version in package/lock feeds both native builders; desktop main and self-check runner share diagnostic protocol; workflow consumes built exe and scripts. No real campus/model validation uses another user's credentials.

Review: fresh reviewer found no blocking regression; strengthened active-view/content and calendar persistence assertions, isolated the forced-parent-death Windows run. Full renderer process-restart is not claimed by the reload check; frozen service is checked across actual restart.

Ruling: Windows forced-exit acceptance keeps the explicit isolated self-check window open with --self-check-hold, preventing a race with the short self-check automatically exiting. Normal launches ignore this hold flag unless --self-check is also present.

Ruling: User selected Windows .exe handoff to a Windows classmate; canceled pending GitHub scope flow and removed inactive-to-active workflow promotion. Local Windows packaging requires no OAuth scope expansion. Windows remains pending until that machine builds and checks it.
