# Execution record

- Baseline: c18cfa1; JS 49 pass; Python 209 with 4 failure + 1 error in auth compatibility assertions.
- Root cause reproduced: LocalBackend._work exits permanently on transient failure. Retry inside loop; offline regression RED then GREEN.
- Design review: fixed origin is required (session partition alone does not solve random port localStorage). Implement pigeonpal://app restricted proxy.
- Design review: use full persistent reminders + deliveredAt rather than bounded 2000-event stream for native recovery; cancelled/done ignored. Native baseline per successful source sync, notice ID independent of analysis revision.
- Native monitor: 5 deterministic tests pass, including 2101-reminder backlog, restart, quiet/mute, failed toast retry.
- Parent EOF: Python service temporary-data lifecycle test passes twice; freezes successfully on macOS; frozen smoke running.
- User confirmed close-to-tray, keep collecting/reminding until explicit quit.
- Windows executable/interactive toast acceptance remain unproven until actual Windows build/acceptance.

- Branch review: fixed all three P2 findings with failing-then-passing regressions: unbounded notification identity index, cancellation/snooze revalidation before each toast, sanitized clipboard write permission only for trusted main frame.
- Real Electron launch exposed HTTP listen backlog resetting concurrent module graph requests; reproduced via 40 parallel asset requests, backlog 128 fixes regression and actual UI renders. Canonical userData/sessionData paths set before ready.
- Mac packaging review found missing frozen CA roots: bundle certifi public roots and runtime hook, keep TLS CERT_REQUIRED/hostname validation; frozen diagnostics/smoke must prove independence from external Python certificate paths.
- User added actual macOS arm64 DMG alongside Windows exe. macOS uses ad-hoc signing, explicit runtime entitlements, no Developer ID/notarization.
- Latest local validation: JS 62 pass; Python full suite rerun before commit, one conditional reference parity skip.

- GitHub rejected activity workflow push: OAuth token missing workflow scope. Original local commit preserved on codex/windows-desktop. Publish reviewed code from c18cfa1 on codex/desktop-preview with workflow moved to inactive build/windows-workflow.yml; no active workflow or exe claim.
- v0.3.0 macOS DMG validated (hdiutil/codesign/frozen TLS + service smoke), mounted app starts and displays real persisted due messages.
- Final suite: 62 JS passed; 222 Python no failures, 1 conditional reference parity skip.
