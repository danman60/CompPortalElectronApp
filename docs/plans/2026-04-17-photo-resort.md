# Photo Re-Sort Plan — UDC London 2026

## Problem
Photos for routines 100-120 were mis-assigned due to:
1. Clock offset adjustment adding +20s to EXIF timestamps (fixed mid-show)
2. Tether match buffer set to 60s, bleeding photos into adjacent routines (fixed to 5s mid-show)

## Recording Windows (from main.log, verified)
```
#101 START 2026-04-17T12:04:04Z        STOP 2026-04-17T12:07:44.372Z
#102 START 2026-04-17T12:07:48.701Z    STOP 2026-04-17T12:10:10.558Z
#103 START 2026-04-17T12:10:14.950Z    STOP 2026-04-17T12:12:51.451Z
#104 START 2026-04-17T12:12:55.836Z    STOP 2026-04-17T12:15:28.826Z
#105 START 2026-04-17T12:15:33.131Z    STOP 2026-04-17T12:18:24.016Z
#106 START 2026-04-17T12:18:28.332Z    STOP 2026-04-17T12:20:45.622Z
#107 START 2026-04-17T12:20:50.110Z    STOP 2026-04-17T12:23:33.991Z
#108 START 2026-04-17T12:23:38.399Z    STOP 2026-04-17T12:26:16.695Z
#109 START 2026-04-17T12:26:27.660Z    STOP 2026-04-17T12:28:38.200Z
#110 START 2026-04-17T12:28:42.637Z    STOP 2026-04-17T12:31:07.019Z
#111 START 2026-04-17T12:31:11.478Z    STOP 2026-04-17T12:33:47.788Z
#112 START 2026-04-17T12:33:52.209Z    STOP 2026-04-17T12:37:17.824Z
#113 START 2026-04-17T12:39:15.875Z    STOP 2026-04-17T12:41:57.153Z
#114 START 2026-04-17T12:42:01.662Z    STOP 2026-04-17T12:44:30.924Z
#115 START 2026-04-17T12:44:35.449Z    STOP 2026-04-17T12:47:01.428Z
#116 START 2026-04-17T12:47:05.911Z    STOP 2026-04-17T12:49:29.928Z
#117 START 2026-04-17T12:49:34.353Z    STOP 2026-04-17T12:52:48.345Z
#118 START 2026-04-17T12:52:52.809Z    STOP 2026-04-17T12:55:21.127Z
#119 START 2026-04-17T12:55:25.778Z    STOP 2026-04-17T12:58:27.391Z
#120 START 2026-04-17T12:58:31.861Z    STOP 2026-04-17T13:01:11.725Z
#121 START 2026-04-17T13:01:16.850Z    STOP 2026-04-17T13:04:50.620Z
#122 START 2026-04-17T13:04:55.302Z    STOP 2026-04-17T13:07:40.213Z
#123 START 2026-04-17T13:07:45.915Z    STOP 2026-04-17T13:10:00.713Z
#124 START 2026-04-17T13:10:07.227Z    STOP 2026-04-17T13:12:34.251Z
```

## Disk State (pre-sort)
```
#100: 6    #106: 754   #112: 54    #118: 168
#101: 2    #107: 158   #113: 335   #119: 203
#102: 3    #108: 139   #114: 224   #120: 237
#103: 2    #109: 130   #115: 192
#104: 3    #110: 143   #116: 199
#105: 1    #111: 149   #117: 344
```
Expected ~20 photos per routine. Most are massively over-assigned.

## DB State (pre-sort)
- Routines 100-117: media_packages exist, status set to `processing` (hidden from SD/parent)
- Routines 113, 115, 116, 118, 119, 120: NO media_packages rows (need creating)
- Photo counts in DB match the contaminated disk counts

## Sort Algorithm
1. Read raw EXIF DateTimeOriginal from each photo (NO clock offset)
2. Match to recording window: exact match first (start ≤ exif ≤ stop), then gap match (start ≤ exif ≤ stop+5s)
3. If photo is in wrong routine directory → move to correct one
4. Renumber photos sequentially in each destination directory
5. Important: do NOT use ffmpeg for EXIF — too CPU heavy. Use PowerShell [System.Drawing] or exiftool

## After Disk Sort
1. Count photos per routine directory on disk
2. Update DB `media_packages.photo_count` to match
3. Create missing `media_packages` rows for 113, 115, 116, 118-120
4. Re-upload photos that are on disk but not in R2 (use Import Photos or manual upload trigger)
5. Flip `media_packages.status` back to `complete` for all affected routines

## CLI Script Location
Script will be at `/tmp/photo_resort.ps1` on DART (or re-pushed from SpyBalloon)

## Future App Feature
Build a "Verify & Re-sort Photos" button in the app that:
- Re-reads all photo EXIF timestamps in routine directories
- Cross-references against recording windows
- Moves mismatched photos
- Triggers re-upload for corrected routines
- Shows a report of what moved

## Caution
- Previous attempt taxed CPU to 99% using ffmpeg per-photo. Use lighter EXIF reader.
- Run during show breaks only, or after the event.
- The running app may fight DB changes by calling plugin/complete — coordinate with app restarts.
