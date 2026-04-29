# Operator issues — status (shipped vs open)
Source: 2026-04-28-operator-issues-grouped.md
Method: git log cross-reference 2026-04-23 → 2026-04-28
Repos: CompSyncElectronApp (CSE), CompPortal (CP)

## Section A — CSE recorder app

| ID | Status | Commit | Notes |
|---|---|---|---|
| A1 | PARTIAL | CSE `efa9b03 v15: auto-import on fresh SD insert + dedup-by-DB + latest-routine-first` / `0cf1c88 boot+driveMonitor` | auto-import + latest-first added; operator still seeing "no jpgs found" 04-26 |
| A2 | PARTIAL | CSE `aafb00c v10: re-record hard-gate modal` | hard-gate landed; auto-stash/cascade UX still open |
| A3 | OPEN | — | no VDD/tablet display fixes since 04-23 |
| A4 | OPEN | — | no monitor/touch-routing commits |
| A5 | SHIPPED | CP `d30ddce2 chat persist via service role` / `d0f7454c UUID message id` | chat persistence + insert fix |
| A6 | PARTIAL | CSE `1e2e183 remove hallucinated 20-photo threshold` / `403914c wake upload worker on boot` / `9859f0f Portal pill stuck none` | several upload-queue fixes; operator still saw stalls 04-26 |
| A7 | OPEN | — | strict 1:1 photo-routine rule not implemented in commits |
| A8 | OPEN | — | no Stream Deck flash/transition commits |
| A9 | OPEN | — | no plugin/asar Stream Deck rollback commit |
| A10 | OPEN | — | EXIF pollution not addressed in commits (investigation only per `afe3c12b 4h-EXIF-bug investigation`) |
| A11 | OPEN | — | no SCRATCH-button replacement commits |
| A12 | OPEN | — | no scan-resumability/sequential-name log commits |
| A13 | SHIPPED | CSE `6d13db4 close-confirmation dialog + filename pre-dedup` | close confirm landed |
| A14 | PARTIAL | CSE `e08e2d2 yield enumerateSdSamples` | yielding may help freeze; not explicitly framed as freeze fix |
| A15 | OPEN | — | no IMPORT COMPLETE wording/semantics commits |
| A16 | SHIPPED | CSE `9655253 make LT iframe render idempotent` | LT overlay glitch fix |
| A17 | OPEN | — | no startup-modal consolidation commits |
| A18 | OPEN | — | no chat-as-admin in CSE |
| A19 | SHIPPED | CSE `b28608d fix(chat): A19 swap chat pin styling from amber to brand purple` | 4 #ffc107 occurrences swapped to --stream-purple (#a855f7) |
| A20 | OPEN | — | pending-vs-actual count discrepancy not addressed |
| A21 | OPEN | — | no tablet-button always-on/1-click restart commits |
| A22 | PARTIAL | CSE `1b98ab8 fix wifi-display respawn loop` / `9297a4f auto-respawn on tablet-IP drift` | respawn fixes landed; baseline display still flaky |
| A23 | PARTIAL | CP `ec11f5c9 latest-photos: show ALL photos per routine` / `cf1d9171 'last shot' uses captured_at` | trim removed + timestamp fixed; round-robin scope broader |
| A24 | SHIPPED | CSE `152b378 v14c: sanitize Windows-reserved chars in routine folder names` | sanitize special chars |
| A25 | SHIPPED | CSE `efa9b03 v15: latest-routine-first upload queue` / `2873904 jobQueue: getNext honors round-robin` | round-robin within entry shipped |
| A26 | OPEN | — | non-sequential filename investigation not in commits |
| A27 | N/A | — | manual scan fallback is operator process, not code |
| A28 | OPEN | — | reimport / "21 missing" issue not addressed by commit |
| A29 | OPEN | — | no explicit dupe-kill on upload queue commit |
| A30 | OPEN | — | no silent-failure alert commit |
| A31 | OPEN | — | no drag/drop UUID safety commit |
| A32 | OPEN | — | no .5 routine drift fix commit |
| A33 | OPEN | — | no 155.5 added-row commit (CP `B32` covers move-in errors) |
| A34 | OPEN | — | no app-state vs DB-state guard commit |
| A35 | OPEN | — | no SCRATCHED CSE→portal sync commit |
| A36 | SHIPPED | CP `53b2635f photographer camera-clock sync page` | mobile sync page shipped |
| A37 | SHIPPED | CSE `7b57839 (snapshot)` | EndOfDayModal.tsx + dayChecklist.ts implemented; auto-fires after last routine recorded; IPC + preload wired (App.tsx:932) |
| A38 | SHIPPED | present in `state.ts` (snapshot) | `getVisibleRoutines()` filters scratched/skipped; defensive walk at state.ts:644-654 advances past scratched currentRoutineId |
| A39 | SHIPPED | CSE `9859f0f v14: fix Portal pill stuck at 'none' after successful upload` | portal status accuracy fix |
| A40 | BLOCKED | — | spec says operator says done but no counter-related commit found 2026-04-23..now; transcript only has "Investigate, dual counter numbers came back" 2026-04-25 15:36 EDT — meaning unclear; needs operator clarification on what "dual counter regression" refers to before verifying |
| A41 | SHIPPED | CSE (this commit) | Controls.tsx isNextEventAwardsBlock() — disables NEXT when next visible routine is across a >=15min gap or different scheduledDay; tooltip explains; gap threshold mirrors RoutineTable.tsx SESSION_GAP_MIN |
| A42 | OPEN | — | no SD-press checkmark removal commit |
| A43 | OPEN | — | no DART CPU mitigation commit |
| A44 | SHIPPED | CSE (this commit) | RoutineTable buildGroupedList — removed sessionContainsCurrent suppression; heads-up row now always visible at ~40-45% through any session with >=6 routines, including the active session (operator needs forward reminder, not retroactive) |
| A45 | N/A | — | discussion of MKV preservation; no code expected |
| A46 | OPEN | — | manual counter-nudge field not built |
| A47 | CLOSED | — | Stream Deck variant shipped; "no re-record button on banner" rule baked into A53/A55 design; no further work per spec |
| A48 | OPEN | — | fetch-failed on app load not addressed |
| A49 | N/A | — | pre-show checklist is operator process |
| A50 | PARTIAL | CSE `b5872b0 v15.2: CLIP cacheDir + auto-import wins renderer race` | cacheDir change may address model path; not confirmed fix for missing onnx |
| A51 | SHIPPED | CSE `9859f0f v14` | "METER-DIAG renderer spam removed (pollutes machine logs)" — verified absent from current src/. Operator complaint 2026-04-24 12:26 EDT predated v14 (14:16 EDT) |
| A52 | OPEN | — | Zero delay on NEXT — change pauseAfterStop / pauseBeforeRecord defaults to 0 (or add "instant" toggle); operator wants stop→start instantaneous, ~4s today |

## Section B — CompPortal media

| ID | Status | Commit | Notes |
|---|---|---|---|
| B1 | N/A | — | Toronto 167-311 R2 relink is data remediation (plan `2026-04-25-r167-r311-video-relink.md`); no portal code commit needed |
| B2 | SHIPPED | CP `9985a783 livestream admin: at-a-glance dashboard redesign` / `aafdf794 more rows` / `96608bd8 Recent Events takes full column` | rich dashboard + larger Recent Events |
| B3 | SHIPPED | CP `9491dac7 visibility toggles publish/unpublish package status` / `561c9acd PARTIAL indicator` / `329bd145 Published/Unpublished label` / `77070406 Uploading on every published routine` | visibility model overhaul |
| B4 | PARTIAL | CP `5b24d2cd EXIF captured_at parity with recorder uploads` | EXIF parity fix; specific routine remediation is data work |
| B5 | SHIPPED | CP `5b24d2cd fix(cd-media/upload): EXIF captured_at parity with recorder uploads` | 4h UTC bug fix on manual upload path |
| B6 | OPEN | — | no CD competition-filter persistence commit |
| B7 | SHIPPED | CP `91f0cfa2 verify-media: 2 new audit rules` / `32351ae7 wave 2 — duration rules, dupe checks, banners` / `6ef0b493 4 new structural checks` / `f61b0f5d exclude pending uploads` | major verify-media expansion |
| B8 | PARTIAL | CP `29a0e31c plugin/complete: pending until photos AND a video URL are both present` | status flow tightened; full audit of stale COMPLETEs not in commits |
| B9 | PARTIAL | CP `41a04ae1 reassign-routine endpoint + whole-routine UI move` / `284a1a01 rewrite storage_url + R2-copy on photo/routine reassign` | reassign infra shipped; per-routine splits remain manual |
| B10 | OPEN | — | no server-side SPLIT function commit |
| B11 | SHIPPED | CP `7bb30eaa MOVE TO picker, PREV/NEXT nav, UPLOAD PHOTOS, hang fix` / `5e01db71 restore MOVE TO PREV/NEXT, surface 500 detail` / `89aeee69 mangle path on storage_url collision` | hang + page-jump + 500 + UX |
| B12 | PARTIAL | CP `a016540d session break rows in Routines panel` / `9ce4201b infer session breaks from performance_time gaps` / `654cb14b revert: director-panel/media session dividers` | inferred breaks live on machine tab; reverted from media page |
| B13 | SHIPPED | CP `9985a783 at-a-glance dashboard redesign` / `dca78ef7 recording pill always visible` / `ced2c31a glow buttons by current machine state` / `8b0d874f Camera Offsets + SD Watermarks` / `50f105f5 Encoding Queue tile` / `24d0aec1 Import Meter` | full CSE state mirror |
| B14 | SHIPPED | CP `cbf93e84 livestream admin: mobile-friendly revamp (zero desktop change)` / `aeffa8cd two mobile-width forcers` | additive mobile revamp |
| B15 | SHIPPED | CP `565e5c65 full-field dancer edit on media dashboard` / `929ab38b slim modal payload + per-field audit diff` | CRUD + audit log |
| B16 | SHIPPED | CP `2688aa82 sage: standalone confirmation modal — no comp/studio prepick` / `015666e9 question overrides on classifier` | standalone confirm modal |
| B17 | OPEN | — | no R2 sequential-jpg gap audit commit |
| B18 | PARTIAL | CP `91f0cfa2`, `32351ae7`, `6ef0b493 verify-media checks` | several wrong-subject/keyframe-related rules added; not all v2 features |
| B19 | OPEN | — | no ghost-row scan commit |
| B20 | OPEN | — | no manual-fix list commit |
| B21 | PARTIAL | CP `89aeee69 fix(reassign-photos): mangle path on storage_url collision` | collision handling for reassign; explicit drop-from-errored not seen |
| B22 | SHIPPED | CP `b1e36dc5 UPLOAD ALL video button + stronger filename parser` / `ef548522 UPLOAD ALL parser handles glued patterns + confirm modal` | upload all + parser |
| B23 | SHIPPED | CP `8b10d5c9 wire Magic Bulk Update modal (Phase 0)` / `d2236013 route write-intent into Bulk Update (Phase 1)` / `f9362ade dancer record edits inside email paste` | magic bulk update on CD media dashboard |
| B24 | SHIPPED | CP `4edaa98e readable chat message timestamps` | timestamp readability; instant-delete not confirmed in messages |
| B25 | OPEN | — | no QR PNG commit |
| B26 | OPEN | — | no Venue TV public schedule commit |
| B27 | SHIPPED | CP `0dd41537 add UDC Toronto VODs to archive` / `8ac92d21 add UDC Toronto Sunday replay (vimeo 1186613803)` | livestream archive updated |
| B28 | OPEN | — | no specific user visibility fix commit (`55c0d03c middleware strip livestream_control_room` partially related) |
| B29 | SHIPPED | CP `73df8484 inline Edit button on Studio Invite modal` | edit button on studio invite |
| B30 | SHIPPED | CP `c1610ad0 show expected media-ready time on empty dancer view` | expected delivery time on family portal |
| B31 | N/A | — | data-recovery investigation; no code expected |
| B32 | OPEN | — | no 155.5 move-in error fix commit |
| B33 | SHIPPED | CP `2032617d support form auto-fills, jump-to-entry clears input` | jump-to-entry behavior |
| B34 | OPEN | — | no per-judge visibility control commit |
| B35 | N/A | — | unconfirmed silent-audio complaint, investigation only |
| B36 | OPEN | — | no tester.compsync.net error fix commit |
| B37 | OPEN | — | no white-on-white modal branding commit |
| B38 | SHIPPED | CP `4a900a8c UPLOAD PHOTOS button on empty routine row` | upload-photos on no-photo routines |
| B39 | SHIPPED | CP `3e17b878 direct-to-R2 presigned flow (was 413 on photos)` | 413 fix |

## Section C — R199 audio

| ID | Status | Commit | Notes |
|---|---|---|---|
| C1 | N/A | — | post-mortem investigation; no code commit yet |
| C2 | OPEN | — | automated audio spot-check feature not built |
| C3 | N/A | — | data inventory work, not code |
| C4 | N/A | — | workflow design, not code |
| C5 | N/A | — | ongoing data alignment work |
| C6 | OPEN | — | per-judge visibility toggle (overlaps B34) not coded |
| C7 | N/A | — | source-pull is data work |
| C8 | N/A | — | render approach planning, not code |

## Section D — Cross-cutting

| ID | Status | Commit | Notes |
|---|---|---|---|
| D1 | SHIPPED | CSE `541b10b v11: machine log streaming — CSE → CompPortal logs endpoint` / `29752543 stream CSE log events to portal + admin logs panel` / `ccb6a4f logStreamer inHook guard` | machine_logs server live |
| D2 | PARTIAL | CSE `58e652f docs(plans): UDC Toronto move-to-transfer + UDC London disk leftover cleanup` / CP `bae282c3 udc-toronto: media-pipeline cleanup scripts + split spec` | plans + scripts; full remediation ongoing |
| D3 | PARTIAL | CSE `58e652f docs(plans): UDC Toronto move-to-transfer` | plan documented; physical move not in code |
| D4 | OPEN | — | no targeted backlog-blocking-uploads fix commit |
| D5 | SHIPPED | CSE `9d9bb69 docs(inbox): R-1..R-10 hardening pitches from CompPortal UDC Toronto retro` / CP `0296bb65 audit: capture all UDC Toronto issues — recs #25-32, R-11, residuals` / `ed40b158 fold CSE-11 post-mortem coordination items into audit doc` / `71301fb7 #22-24 + R-1..R-10 recorder hardening pitches` | post-mortem rollup documents |

## Summary
- SHIPPED: 31
- PARTIAL: 14
- OPEN: 48
- N/A: 11
- Total: 104
