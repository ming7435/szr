# Natural Face Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans; native implementation plus final independent reviewer.

**Goal:** Improve current-audio lips and add natural basic eye/brow movement to 李云龙 on this Intel Arc Windows machine.
**Architecture:** Native 256px audio lip model with cached portrait features; verified learned expression poses prepared locally then combined dynamically in a separate upper-face canvas. Preserve existing PCM/audio clock and cancellation.
**Tech Stack:** OpenVINO, OpenCV, Python, native JS/Canvas/WebAudio.
**Spec:** docs/superpowers/specs/2026-10-09-natural-face-design.md

## Global Constraints
- Fixed original office portrait, cloned voice S_dCBmWoBh2, name 李云龙; no conversation captions.
- Only current Intel Arc Windows computer; no paid service or external-account changes.
- PCM remains byte-for-byte unchanged; current-audio lip frames at20FPS in distinct two-frame batches, cancellation removes old audio/mouth.
- Do not claim realistic emotions or whole-face motion if only basic eye/brow animation is shipped.

## Review Focus
- Missing/mismatched portrait assets must not show another person's expression.
- Asset decode after disposal must not restore animation.
- New reply and interruption must not restore stale mouth.
- Reduced-motion, hidden page and motion toggle must release animation scheduling.
- Mouth image must not be covered by eye/eyebrow overlay.

### Task 1: Isolated native mouth and expression model verification
Files: output/full-face-probe; source scripts only after success.
- [x] Download publisher models, verify metadata/ZIP integrity, safe weights-only load.
- [x] Same-PCM and photo visual comparison; actual native inference benchmark and original PCM identity.
- [x] Generate learned expression poses for this photo, inspect closed/open eye/brow output and infer performance.

### Task 2: Production current-audio mouth and dynamic eye/brow integration
Files: scripts/avatar-worker.py, public/face-expression.js, public/index.html, public/app.js, CSS, tests.
- [x] Write failing regression for verified selected mouth output contract and cancellation.
- [x] Implement selected lip path retaining paired PCM,20FPS and UUID cancellation.
- [x] Write failing browser tests for loading failure, smooth blinking/state updates, disposal and visibility/motion toggles.
- [x] Implement transparent upper-face animation without touching synchronized mouth.

### Task 3: Actual browser acceptance and review
- [x] Actual GPU+Chrome full reply playback, no audio gaps, byte identity, eye animation and interruption.
- [x] Native tests, meaningful visual contact sheet and actual live cloud check only if newly necessary.
- [x] Independent review and concrete fixes; update docs and keep server warm for user.

## Execution Ledger
User already authorized improving lips and expressions. Native execution continues without redundant design approval. Current app stays working while models are tested in isolation.

Selected cached-feature native model with unmodified decoder and batch2. Rejected constant-convolution split because IntelGPU output differed from CPU/publisher; no such split runs in production.20FPS with one initial200ms cushion keeps current-audio native high-resolution lips continuous on this machine. LivePortrait GPU compilation unsupported and CPU too slow for realtime; only verified learned eye/brow poses run dynamically in browser.

Actual worker151 frames32.51 processingFPS, original PCM/portrait unchanged. Chrome151 frames zero audio gaps, finaltail and blink while speaking. Actual Doubao+GPU+Chrome first audible/visible1.1718s after speech ended, own voice unchanged, listening/thinking/responding eye states, mute, interrupt, late frames and microphone release pass. Independent recheck: no Critical/Important; hash validation, media-query changes and immediate pending-load disposal fixed. Current server PID21480, localhost4173, GPU model warm. Full regression rerun recorded in docs/progress.md.
