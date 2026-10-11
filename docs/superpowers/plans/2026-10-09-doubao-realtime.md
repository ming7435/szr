# Doubao Realtime Implementation Plan

> For agentic workers: use native task-by-task implementation with a final independent review.

**Goal:** Connect the existing voice-only avatar to Doubao streaming speech with the user's own cloned voice.
**Architecture:** Local WebSocket proxy keeps credentials private; browser streams PCM and plays PCM chunks as received. Provider selection is explicit and never silently falls back.
**Tech Stack:** Node.js, ws8.22.0, Windows DPAPI, native Web Audio/AudioWorklet.

**Verification 2026-10-09:** 51 Node tests and 15 native Chrome browser tests passed. Independent review found and verified fixes for a delayed interruption cancelling the next question and for valid fast PCM bursts exhausting the playback queue. Local readiness probe confirms selected/unconfigured Doubao with API Key settings and unchanged portrait. Evidence: output/doubao-setup-verification.json and output/doubao-settings-ready.png. No cloud request or purchase was made; real dialogue/voice/latency remain pending account setup.
**Spec:** docs/superpowers/specs/2026-10-09-doubao-realtime-design.md

## Global Constraints

Keep exact office portrait, fixed uploaded speaker, no transcripts or voice-preview strip. Private settings never reveal the Access Token; no live cloud requests until configured. User performs account setup/purchase and confirms the cloned voice ID.

## Review Focus

Malformed or gzip-expanded frames; missing/foreign Origin; client disconnect during credential reads; late old audio after interruption; stale audio/context/microphone after start cancellation.

## Task 1: Provider bridge and private configuration

- [x] Write failing tests for binary codec, bounded parsing, fixed cloned voice, DPAPI storage/public redaction, localhost WebSocket guard and cancellation filtering.
- [x] Implement doubao-protocol.mjs encode/decode; doubao-service.mjs publicConfig/saveSettings/attach/close. No automatic voice training or slot purchases.
- [x] Integrate server config/settings and upgrades; run protocol/service tests against a local fake upstream.

## Task 2: Native streaming conversation and setup

- [x] Write failing tests for first PCM playback without full response, ordered audio, interruption, release and missing configuration before microphone acquisition.
- [x] Implement public/doubao-conversation.js and streaming worklet. Wire voice selection/configuration into existing app/settings, with cloud setup guide and sample download.
- [x] Run native Chrome tests and inspect screenshot; maintain previous transport tests.

## Task 3: Review, ready state, handoff

- [x] Independent review and fix reproduced defects; full Node/browser checks.
- [x] Restart local server, verify honest unconfigured Doubao status and private secret absence.
- [x] Provide Chinese setup guide linking official console and local settings. Actual latency/voice verification remains pending the user's own cloud configuration.
