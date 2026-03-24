# CompSync Media — Human Operator Test Checklist

**Pre-requisites:** Windows PC, OBS Studio, 2+ cameras, SD card reader, photo camera, competition CSV loaded.

Run automated tests first (`npx playwright test`) — this checklist covers hardware-dependent tests only.

---

## 1. Two-Camera Setup & Switching

**Setup:** Connect 2 cameras to OBS (e.g., main stage + judge cam). Configure OBS scenes for each.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 1.1 | Add Camera 1 as OBS Video Capture | OBS shows live feed | [ ] |
| 1.2 | Add Camera 2 as OBS Video Capture | OBS shows live feed | [ ] |
| 1.3 | Connect CompSync to OBS (Settings → OBS URL) | Green "Connected" badge | [ ] |
| 1.4 | Verify OBS input list shows both cameras | `obsGetInputList` returns both sources | [ ] |
| 1.5 | Switch OBS scene from Cam 1 to Cam 2 mid-recording | Recording continues without interruption | [ ] |
| 1.6 | Switch back to Cam 1 | Recording still active, no frame drops | [ ] |
| 1.7 | Stop recording after scene switches | MKV file contains both camera feeds in sequence | [ ] |

**Notes:** ____________________________________________

---

## 2. Photo Camera Setup & Test Photos

**Setup:** DSLR/mirrorless with correct date/time, shooting to SD card.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 2.1 | Verify camera clock matches PC clock (±30s) | Times align — important for EXIF matching | [ ] |
| 2.2 | Take 3 photos during a recording | Photos timestamped within recording window | [ ] |
| 2.3 | Take 2 photos between recordings (gap) | Photos timestamped in gap between routines | [ ] |
| 2.4 | Take 1 photo with no recording active | Photo should be "unmatched" | [ ] |
| 2.5 | Check photo filenames are sequential (IMG_xxxx) | Camera naming convention works with import | [ ] |

**Notes:** ____________________________________________

---

## 3. Overlay Testing (All Features)

**Setup:** OBS Browser Source pointed at `http://localhost:9876/overlay`, 1920×1080.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 3.1 | Counter visible with correct entry # / total | Number updates on routine advance | [ ] |
| 3.2 | Toggle counter off/on | Disappears/reappears in OBS preview | [ ] |
| 3.3 | Clock visible and ticking | Shows current time, updates every second | [ ] |
| 3.4 | Toggle clock off/on | Disappears/reappears | [ ] |
| 3.5 | Logo displays configured image | Logo URL renders correctly | [ ] |
| 3.6 | Toggle logo off/on | Disappears/reappears | [ ] |
| 3.7 | Fire lower third manually | Animates in with entry#, title, dancers, studio, category | [ ] |
| 3.8 | Lower third auto-hides after configured seconds | Animates out on timer | [ ] |
| 3.9 | Hide lower third manually before timer | Hides immediately | [ ] |
| 3.10 | Test each animation: slide, zoom, fade, rise, sparkle | All 5 animations render correctly | [ ] |
| 3.11 | Auto-fire on routine advance | LT fires 3s after pressing Next | [ ] |
| 3.12 | Toggle individual LT fields off (e.g., hide category) | Field disappears from LT, others remain | [ ] |
| 3.13 | Overlay visible in OBS recording output | Lower third burns into recorded video | [ ] |

**Notes:** ____________________________________________

---

## 4. Record & Process Video

**Setup:** OBS connected, competition loaded, at least 3 routines.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 4.1 | Press Start Record in CompSync | OBS begins recording, red indicator | [ ] |
| 4.2 | Advance through routine (Next) | Routine marked as "recording" | [ ] |
| 4.3 | Press Stop Record | OBS stops, MKV file saved to output dir | [ ] |
| 4.4 | FFmpeg encoding starts automatically | Progress bar shows encoding state | [ ] |
| 4.5 | Encoding completes without errors | Status changes to "encoded" | [ ] |
| 4.6 | Record 3 routines back-to-back | All 3 produce separate MKV files | [ ] |

**Notes:** ____________________________________________

---

## 5. Main Recording + Smaller Videos

**Setup:** Judge count ≥ 1 in settings, multi-track audio in OBS.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 5.1 | Record with judgeCount=2 | MKV has 1 video + 3 audio tracks (perf + 2 judges) | [ ] |
| 5.2 | After encoding: verify `P_performance.mp4` exists | Main recording with performance audio | [ ] |
| 5.3 | Verify `J1_commentary.mp4` exists | Judge 1 track extracted correctly | [ ] |
| 5.4 | Verify `J2_commentary.mp4` exists | Judge 2 track extracted correctly | [ ] |
| 5.5 | Play each MP4 — audio matches expected track | Performance has music, judges have commentary | [ ] |
| 5.6 | File sizes reasonable (main > judges typically) | No empty or truncated files | [ ] |
| 5.7 | Original MKV preserved after encoding | Source file not deleted | [ ] |

**Notes:** ____________________________________________

---

## 6. Upload to Correct Routine Slots

**Setup:** Share code loaded, competition connected to CompPortal API.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 6.1 | Encode routine #1, start upload | Upload progress shows in UI | [ ] |
| 6.2 | Check CompPortal — routine #1 has `performance.mp4` | Video appears in correct entry slot | [ ] |
| 6.3 | Check CompPortal — routine #1 has `judge1.mp4` | Judge track in correct slot | [ ] |
| 6.4 | Encode routine #5, upload | Goes to entry #5 slot, not #1 | [ ] |
| 6.5 | Upload photos for routine | Photos appear under correct entry | [ ] |
| 6.6 | Pause upload mid-transfer | Upload pauses, resumes cleanly | [ ] |
| 6.7 | Kill app mid-upload, relaunch | Job queue resumes pending uploads | [ ] |

**Notes:** ____________________________________________

---

## 7. Photos Import from SD Card

**Setup:** SD card with photos taken during a recorded session.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 7.1 | Insert SD card, browse to DCIM folder | Folder picker shows SD card path | [ ] |
| 7.2 | Import photos | Progress bar, EXIF timestamps read | [ ] |
| 7.3 | Clock offset detected and applied | Log shows offset (e.g., "camera behind by 15s") | [ ] |
| 7.4 | Photos matched to correct routines | Match count reasonable (most matched) | [ ] |
| 7.5 | Unmatched photos identified | Photos outside any recording window flagged | [ ] |
| 7.6 | Import 500+ photos (large batch) | Completes without OOM or hang | [ ] |

**Notes:** ____________________________________________

---

## 8. Photos Sorted into Local Folders

**Setup:** Photos imported (step 7 complete).

| # | Step | Expected | Pass |
|---|------|----------|------|
| 8.1 | Check output directory for routine folders | Folders named `{entryNum}_{title}_{studioCode}/photos/` | [ ] |
| 8.2 | Each folder has correct photos | Photos from recording window in matching folder | [ ] |
| 8.3 | Thumbnails generated (200×200 WebP) | `.thumb/` subfolder with thumbnails | [ ] |
| 8.4 | No duplicate photos across folders | Each photo in exactly one folder | [ ] |
| 8.5 | CLIP re-sort available for ambiguous matches | PhotoSorter UI accessible, shows transitions | [ ] |
| 8.6 | CLIP re-sort produces clean group boundaries | Side-by-side preview shows correct split points | [ ] |
| 8.7 | Execute sort copies/moves files correctly | Files in final destination, originals handled per setting | [ ] |

**Notes:** ____________________________________________

---

## 9. Photos Uploaded with Video

**Setup:** Routine with both encoded video and matched photos.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 9.1 | Upload routine with video + photos | Both types queued in job queue | [ ] |
| 9.2 | Videos upload first, then photos | Upload order correct | [ ] |
| 9.3 | Check CompPortal — photos appear under routine | Images visible in media portal | [ ] |
| 9.4 | Photo filenames preserved | Original names (IMG_xxxx.jpg) intact | [ ] |
| 9.5 | Content-type is image/jpeg | Server receives correct MIME type | [ ] |

**Notes:** ____________________________________________

---

## 10. App Stability Throughout

**Setup:** Full session — load comp, record 10+ routines, import photos, upload.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 10.1 | Run for 2+ hours continuously | No crashes, freezes, or memory leaks | [ ] |
| 10.2 | CPU stays below 60% at idle (no recording) | System monitor shows acceptable load | [ ] |
| 10.3 | CPU during encoding stays manageable | FFmpeg priority setting works | [ ] |
| 10.4 | Memory usage stable (not growing over time) | Check Task Manager — stays under 800MB | [ ] |
| 10.5 | UI remains responsive during encoding | Can click buttons, navigate while encoding runs | [ ] |
| 10.6 | UI remains responsive during upload | Can click buttons, navigate while uploading | [ ] |
| 10.7 | No orphaned FFmpeg processes after session | Task Manager clean after app close | [ ] |

**Notes:** ____________________________________________

---

## 11. Test While Streaming / Recording / WiFi Display

**Setup:** OBS streaming to a test endpoint, recording active, overlay browser source loaded, StreamDeck/phone connected via WebSocket.

| # | Step | Expected | Pass |
|---|------|----------|------|
| 11.1 | Start streaming + recording simultaneously | Both active, no conflict | [ ] |
| 11.2 | Overlay updates while streaming | Lower third visible in stream output | [ ] |
| 11.3 | WebSocket remote control works during stream | StreamDeck can fire LT, advance routines | [ ] |
| 11.4 | Stream quality stable during encoding | No dropped frames in OBS stats | [ ] |
| 11.5 | Recording quality unaffected by streaming | MKV quality same as non-streaming | [ ] |
| 11.6 | WiFi display (WebSocket) latency acceptable | Commands execute within 500ms | [ ] |
| 11.7 | Multiple WebSocket clients simultaneous | Overlay + StreamDeck + phone all connected | [ ] |

**Notes:** ____________________________________________

---

## 12. End-of-Test Stats Collection

After completing all tests, record these metrics:

| Metric | Value |
|--------|-------|
| **Total disk space used** (output dir) | _______ GB |
| **MKV files generated** | _______ files, _______ GB |
| **MP4 files encoded** | _______ files, _______ GB |
| **Photos imported** | _______ files, _______ MB |
| **Peak CPU during encoding** | _______ % |
| **Avg CPU during recording** | _______ % |
| **Idle CPU (no activity)** | _______ % |
| **Peak memory usage** | _______ MB |
| **Streaming bitrate** | _______ kbps |
| **Dropped frames (OBS)** | _______ |
| **Total session duration** | _______ hours |
| **Crashes / hangs** | _______ |
| **Upload failures** | _______ |
| **Photo match accuracy** | _______% matched correctly |

---

## Sign-off

| | Name | Date | Result |
|--|------|------|--------|
| **Tester** | | | PASS / FAIL |
| **Reviewed by** | | | |

**Overall notes:**

