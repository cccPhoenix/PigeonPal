# Windows Desktop and Reliable Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 修复抓取/提醒真实缺陷并交付可安装 Windows exe 与本机原生提醒。
**Architecture:** Existing Python local service in a bundled sidecar, Electron shell and independent durable notification monitor. Reuse existing UI; no multi-bot changes.
**Tech Stack:** Python 3.12, Electron, PyInstaller, electron-builder NSIS.
**Spec:** docs/superpowers/specs/2026-10-18-windows-desktop-design.md

## Global Constraints
- Windows x64; no bundled user data, credentials or API keys; no forced campus login.
- Preserve local-only homework and reminder scheduling without model calls.
- Use loopback port 0, single instance, parent-owned child lifecycle; do not hijack developer service.
- Preserve stable frontend storage despite random backend port.
- Notification preferences/quiet hours and dedupe persist; no duplicate renderer/native delivery.

## Review Focus
- New user with empty/no auth/no API key still starts and public crawl works.
- Hidden renderer, restart and temporary local service/disk error do not silently lose reminders.
- Untrusted external URLs/messages cannot access Electron IPC privileges.
- Storage never goes in install/asar/temp extraction directories and persists upgrades.
- Window close vs quit, child crash/parent crash and port conflicts are distinguishable.

### Task 1: Audit and repair current pipelines
- [x] Run baseline JS and Python suites; reproduce auth regressions offline.
- [ ] Reconcile stale tests against confirmed protocol and fix actual CAS defects; preserve target validation.
- [ ] Add failing worker recovery regression; keep source failures isolated/retryable.
- [ ] Run suites and document exact coverage/remaining real login limits.

### Task 2: Native delivery core
Files: desktop/notifications.cjs, desktop/state.cjs, tests/desktop-notifications.test.mjs.
- [ ] Add failing tests for baseline/new item/event paging/restart/quiet/mute/error retry/grouping.
- [ ] Implement source revision monitor and event cursor independent of renderer; atomic local state.
- [ ] Verify deterministic tests without private data or OS notification side effects.

### Task 3: Shell and owned backend
Files: desktop/main.cjs, desktop/preload.cjs, desktop/backend.cjs, scripts/desktop_service.py, web/js/services/desktop.js, web/js/main.js, web/js/ui/settings.js.
- [ ] Add failing lifecycle/storage/IPC tests; implement private handshake, stable session, tray/quit and safe external navigation.
- [ ] Implement preference bridge, click-to-channel and one notification owner.
- [ ] Run local shell against temporary synthetic backend data and verify rendered UI.

### Task 4: Windows distribution
Files: build/backend.spec, build/build_backend.py, electron-builder.yml, package.json, requirements-build.txt, .github/workflows/windows.yml, docs/desktop.md.
- [ ] Freeze sidecar with web assets; use explicit app files/extraResources allowlist.
- [ ] Windows runner tests/build/sidecar smoke/installer smoke + SHA256 artifact.
- [ ] Inspect artifact contents for forbidden private files; deliver actual exe only when built, otherwise report exact build blocker and retain active goal.
