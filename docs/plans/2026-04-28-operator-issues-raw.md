# Operator-stated issues — raw extraction
Source: transcripts 2026-04-23 through 2026-04-28
Extracted: 2026-04-28
Method: verbatim operator quotes, no Claude commentary

Cross-reference notation: `[file|approx-line|HH:MM:SS EDT]`. Quotes preserve original typos and capitalization.

---

## A. CSE recorder app issues

### Tablet display / touch / wifi-display

1. [2026-04-23/CompSyncElectronApp.md|L401|20:46:20 EDT] "The tablet previously loaded with no no touch in display. I restarted and now it has no touch and no display. It's been flaky in general and even when it's running not flaky. There is too much delay for the operator"
   Context: night-before show, tablet + multi-monitor flakiness baseline.

2. [2026-04-23/CompSyncElectronApp.md|L433|20:48:26 EDT] "But it does need to not be thrown off by that"
   Context: re: third-monitor topology change disabling tablet.

3. [2026-04-23/CompSyncElectronApp.md|L480|20:52:36 EDT] "What can you do about more consistently displaying the feed and touch and speeding up the latency"

4. [2026-04-23/CompSyncElectronApp.md|L490|21:10:34 EDT] "Again the websocket's fine. I'm talking about the display portion"

5. [2026-04-23/CompSyncElectronApp.md|L763|21:55:46 EDT] "Touches are still not working on the tablet. I can see that it is touching on monitor two when the tablet itself is on monitor 3 The correct monitor is chosen in comp sync settings. I need the app to only ever display touches on the monitor that it is live on"

6. [2026-04-24/CompSyncElectronApp.md|L1495|11:17:54 EDT] "Tablet connects but it is being identified as screen two and not screen 3 taps on it are registering on screen one"

7. [2026-04-24/CompSyncElectronApp.md|L1525|11:31:50 EDT] "Restarting definitely as admin and now tablet won't display at all. We need a code fixed for the tablet"

8. [2026-04-24/CompSyncElectronApp.md|L1626|11:39:42 EDT] "Tablet still being identified as monitor two taps registering on monitor. One exact same"

9. [2026-04-24/CompSyncElectronApp.md|L2287|13:16:55 EDT] "ok start a fresh session; i still want to get the app and tablet working with the third monitor; why can't the taps just be locked to the monitor thats hooked up to vdd"

10. [2026-04-24/CompSyncElectronApp.md|L3327|14:09:09 EDT] "Tablet display freezes after while now it's black on restart, needs to be hardier, it has logs we built from last session that you can check"

11. [2026-04-24/CompSyncElectronApp.md|L3854|14:32:18 EDT] "Black screen on tablet even after successful connection"

12. [2026-04-24/CompSyncElectronApp.md|L3941|14:38:13 EDT] "Did, still black, restarted tablet app still black"

13. [2026-04-24/CompSyncElectronApp.md|L3968|14:40:51 EDT] "It got one frame and then froze and is not getting the right feed from Windows"

14. [2026-04-24/CompSyncElectronApp.md|L4016|14:51:57 EDT] "i have the current apk open... on windows OBS MULTIVIEW is assinged to VDD and appears properly in CRD, but the tablet feed shows the wrong feed that I'm tyring to send to a different montior"

15. [2026-04-24/CompSyncElectronApp.md|L4022|14:54:38 EDT] "i ALWAYS WANT the App to be locked ot VDD TOUCH AND DISPLAY, also I'm watching it the tablet now with app leoaded and it's sending 1 frame ~30s or so"

16. [2026-04-24/CompSyncElectronApp.md|L4059|15:00:23 EDT] "are there multipe wifi display instances spammed on dart?"

17. [2026-04-24/CompSyncElectronApp.md|L4873|15:49:31 EDT] "same 1 frame every 15s"

18. [2026-04-24/CompSyncElectronApp.md|L7056|17:57:43 EDT] "tryin on show tablet and stiill black"

19. [2026-04-24/CompSyncElectronApp.md|L7077|17:59:10 EDT] "i can confirm via CRD that VDD correctly has the mutliview but its black on tablet"

20. [2026-04-24/CompSyncElectronApp.md|L7128|18:02:31 EDT] "Touches are laggy"

21. [2026-04-25/CompSyncElectronApp.md|L3643|15:08:41 EDT] "Can we change tablet button function to always on by default, 1 click to restart the server instead of toggle"

22. [2026-04-25/CompSyncElectronApp.md|L3726|15:13:40 EDT] "Kk. Wi-Fi display still laggy during encode"

### Photo import / SD scan / matching pipeline

23. [2026-04-24/CompSyncElectronApp.md|L2055|13:02:18 EDT] "https://udc.compsync.net/dashboard/director-panel/media/latest-photos?competitionId=a0adef31-177b-4dd6-8b63-7ff59fff0196 only showing 6 photos"

24. [2026-04-24/CompSyncElectronApp.md|L2089|13:03:47 EDT] "i thought we did round robin on the import in the app to get more photos across more routines?"

25. [2026-04-24/CompSyncElectronApp.md|L2125|13:05:53 EDT] "i need the whol chain of import/match/upload to support getting more routines on that page tho; the goal is for that page to rapidly show scattered photos across ALL ROUTIENS AS FAST AS POSSIBLE once card is in; for a live show flow. And you just showed me a UTC time code when your instructions say EST"

26. [2026-04-24/CompSyncElectronApp.md|L2137|13:07:53 EDT] "are you sure? The card shoul dhave photos from 8--850am not just that time"

27. [2026-04-24/CompSyncElectronApp.md|L4438|15:20:46 EDT] "i need those photos pariing/matching/uploading now"

28. [2026-04-24/CompSyncElectronApp.md|L4520|15:28:33 EDT] "just saw this import.failed
   11:27:33 AM
   {
    \"error\": \"ENOENT: no such file or directory, mkdir 'C:\\\\Users\\\\User\\\\OneDrive\\\\Desktop\\\\TesterOutput\\\\130_CAN_YOU_DO_THIS?_\\\\photos'\",
    \"folderPath\": \"F:\\\\DCIM\"
   }"

29. [2026-04-24/CompSyncElectronApp.md|L4578|15:35:01 EDT] "is it stil lblocked? it shouldn't block on a character like that"

30. [2026-04-24/CompSyncElectronApp.md|L5352|16:19:54 EDT] "No we added some sort of quicker scanner that seems to not actually scan the whole drive, that commit was today ~9am"

31. [2026-04-24/CompSyncElectronApp.md|L5405|16:21:05 EDT] "no I need this workign now; why is it not scannign all phoots"

32. [2026-04-24/CompSyncElectronApp.md|L5465|16:24:06 EDT] "but i want the app to be auto sacnning/matchign photos and not require that click"

33. [2026-04-24/CompSyncElectronApp.md|L5477|16:25:38 EDT] "i want to SCAN all photos to make sure, but I only want phtoos imported that HAVENTE BEEN IMPORTED yet. Yes if WRONG DAY or off by more than 5min dont fire"

34. [2026-04-24/CompSyncElectronApp.md|L5778|16:33:01 EDT] "are latest routines uploading? latest photo page says 2hr ago https://udc.compsync.net/dashboard/director-panel/media/latest-photos?competitionId=a0adef31-177b-4dd6-8b63-7ff59fff0196"

35. [2026-04-24/CompSyncElectronApp.md|L5832|16:37:48 EDT] "wtf just tell me whats going on; why is latest photo page show last photo from 2hr ago? My expectation is latest routines photos get uploaded routnd robin"

36. [2026-04-24/CompSyncElectronApp.md|L5916|16:41:29] "WAIT WHAT"

37. [2026-04-24/CompSyncElectronApp.md|L5922|16:41:35 EDT] "WE HAVE POLLUTED CAPTURE TIE?"

38. [2026-04-24/CompSyncElectronApp.md|L5924|16:41:41 EDT] "WE HAVE POLLUTED CAPTURE TIE?THAT WILL AFFECT ALL SORTING"

39. [2026-04-24/CompSyncElectronApp.md|L6066|16:46:02 EDT] "this might have been the FAKE IMPORT COMPLETE bug that we fixed in later commit"

40. [2026-04-24/CompSyncElectronApp.md|L6100|16:48:46 EDT] "I think the big147-159 is due to the 1000 matching bug we fixed."

41. [2026-04-24/CompSyncElectronApp.md|L6118|16:49:04 EDT] "upload queeue should never get stuck like this though"

42. [2026-04-24/CompSyncElectronApp.md|L6148|16:50:19 EDT] "but round robin within entry number right? So newest routines jump ahead but dont wait for a full routiens phootos before next one?"

43. [2026-04-24/CompSyncElectronApp.md|L6168|16:52:34 EDT] "so we haven't shipped newest asar yet, but one of the 2 sds is back in and only said 21 photos were found missing"

44. [2026-04-24/CompSyncElectronApp.md|L6338|17:08:12 EDT] "do a manual scan of card for exifs that match; theres only 1 camera body and it shouldn't have any drft"

45. [2026-04-24/CompSyncElectronApp.md|L6407|17:12:16 EDT] "you also didn't mnually scan the other SD we relied on the app"

46. [2026-04-24/CompSyncElectronApp.md|L6766|17:30:55 EDT] "also the app froze briefly on SD insert, can't have that as the card gets very full"

47. [2026-04-24/CompSyncElectronApp.md|L6803|17:33:02 EDT] "that is the text; but YOU DID FNID THE MISSING PHTOOS"

48. [2026-04-24/CompSyncElectronApp.md|L6807|17:33:10 EDT] "is it reimporting 5k photos?"

49. [2026-04-24/CompSyncElectronApp.md|L6854|17:35:39 EDT] "app is saying import complete is that true?"

50. [2026-04-24/CompSyncElectronApp.md|L6883|17:37:05 EDT] "But you found 147-166 photos on card yes? I cna tell you 147 had its VIDEO RECORDING HAVE OPERATOR ERROR"

51. [2026-04-24/CompSyncElectronApp.md|L7140|18:04:27 EDT] "Yes the app is showing many routines stuck in uploading"

52. [2026-04-24/CompSyncElectronApp.md|L7172|18:13:34 EDT] "uploads all look stuck in app"

53. [2026-04-24/CompSyncElectronApp.md|L7290|18:18:24 EDT] "was dashboard fix ever pushed? i need to see the amounto of uploads left etc"

54. [2026-04-24/CompSyncElectronApp.md|L7305|18:19:03 EDT] "showing 11k pending is that true?!"

55. [2026-04-24/CompSyncElectronApp.md|L7323|18:19:48 EDT] "Yes we need to kill dupes"

56. [2026-04-24/CompSyncElectronApp.md|L7333|18:20:25 EDT] "need the pipe clena"

57. [2026-04-24/CompSyncElectronApp.md|L7361|18:21:23 EDT] "wait ALL photo jobs? You konw which are dupes right?"

58. [2026-04-24/CompSyncElectronApp.md|L7491|18:38:34 EDT] "you cleared the queue? Did you clear areal items?"

59. [2026-04-24/CompSyncElectronApp.md|L7502|18:39:17 EDT] "i have no recent events in my log what is going on are they uploaded or not"

60. [2026-04-24/CompSyncElectronApp.md|L7534|18:40:09 EDT] "APP HAS BEEN BOOTED FOR 20 min"

61. [2026-04-24/CompSyncElectronApp.md|L7550|18:41:07 EDT] "That commit must have broke something; i have no machine logs"

62. [2026-04-24/CompSyncElectronApp.md|L7574|18:42:21 EDT] "recent event slog in https://udc.compsync.net/dashboard/admin/livestream empty and ARE UPLOADS GOING OR NOT"

63. [2026-04-24/CompSyncElectronApp.md|L7587|18:42:54 EDT] "AUTO UPLOAD IS ON"

64. [2026-04-24/CompSyncElectronApp.md|L8601|20:12:27 EDT] "All of the recent routines should have been imported but they need to show uploading"

65. [2026-04-24/CompSyncElectronApp.md|L8605|20:12:27 EDT] "And you told me that the latest routines should be jumping the upload queue"

66. [2026-04-24/CompSyncElectronApp.md|L8676|20:15:13 EDT] "Then why the absolute garbage duck? Would you tell me that no data exists for those routines"

67. [2026-04-24/CompSyncElectronApp.md|L8684|20:16:35 EDT] "But the card went into the app and showed complete. So according to the apps UI, all of those photos were imported"

68. [2026-04-24/CompSyncElectronApp.md|L8693|20:17:24 EDT] "That's not what I'm saying. If the import is complete then those newest routines should be uploading via round. Robin"

69. [2026-04-24/CompSyncElectronApp.md|L8732|20:20:38 EDT] "But that defeats the whole point of latest photos."

70. [2026-04-24/CompSyncElectronApp.md|L8792|20:23:51 EDT] "Why on Earth would it be set up that way? We just want that page to show the latest photos. Then as long as the app is prioritizing the latest imported photos into upload, they should appear on the page. I never asked for a photo minimum before they appear that's ridiculous"

71. [2026-04-25/CompSyncElectronApp.md|L643|03:05:20 EDT] "Day one shot 15K photos but there's 29k pending?"

72. [2026-04-25/CompSyncElectronApp.md|L703|03:11:48 EDT] "Well that sounds like a complete mess because photos should never match to more than one routine should they"

73. [2026-04-25/CompSyncElectronApp.md|L751|03:18:00 EDT] "Even 19k sounds like the full days photos when a bunch of photos already exist that have been uploading today"

74. [2026-04-25/CompSyncElectronApp.md|L912|03:35:11 EDT] "Wait there's non -sequential camera file names in the Toronto comp?"

75. [2026-04-25/CompSyncElectronApp.md|L2046|13:12:07 EDT] "There are today's photos on card guaranteed, they have different camera sequential prefix than yesterday"

76. [2026-04-25/CompSyncElectronApp.md|L2124|13:15:51 EDT] "Although the IMPORTING message should say SCANNING if it's not importing"

77. [2026-04-25/CompSyncElectronApp.md|L4133|15:56:03 EDT] "Very long scan happening, surely we don't need to scan so many photos.... This will only get bigger..."

78. [2026-04-25/CompSyncElectronApp.md|L4198|15:58:26 EDT] "And the app is saying import complete now. Is that true or just the scan that completed?"

79. [2026-04-25/CompSyncElectronApp.md|L4223|15:59:18 EDT] "So I have a think through that piece of UI as well and pitch a entire consolidated flow"

80. [2026-04-25/CompSyncElectronApp.md|L4236|16:00:33 EDT] "Also just noting that it does clog OBS so maybe we want to have it used 70% of the processing power that it currently is"

81. [2026-04-25/CompSyncElectronApp.md|L7105|20:09:26 EDT] "IMPORT COMPLETE needs to mean that the card can be ejected immediately"

82. [2026-04-26/CompSyncElectronApp.md|L1885|20:40:13 EDT] "Tehre are phtoos from today though"

83. [2026-04-26/CompSyncElectronApp.md|L1911|20:41:11 EDT] "we went over this 1k times....it needs to find the LATEST UNIPORTED PHOTOS and import then"

84. [2026-04-26/CompSyncElectronApp.md|L1923|20:41:58 EDT] "i ran manual and it says import complete; BUG"

85. [2026-04-26/CompSyncElectronApp.md|L1939|20:43:02 EDT] "BLARG"

86. [2026-04-26/CompSyncElectronApp.md|L1941|20:43:02 EDT] "we didn't do any commits today so why did it work from 89"

87. [2026-04-26/CompSyncElectronApp.md|L1959|20:44:30 EDT] "Top left UI toast... this pipe is still BROKEN and we need it working RIGHT THE F NOW"

88. [2026-04-26/CompSyncElectronApp.md|L1993|20:50:50 EDT] "THEN WHY DID IT BREAK AT 9AM"

89. [2026-04-26/CompSyncElectronApp.md|L2007|20:51:21 EDT] "WHAT CHANGED"

90. [2026-04-26/CompSyncElectronApp.md|L2019|20:52:46 EDT] "THERE ARE 2 CARDS AND THERE ALWAYS HAS BEEN IN"

91. [2026-04-26/CompSyncElectronApp.md|L2072|20:57:37 EDT] "add to incident report WHAT I WANT IS PHOTOS TO AUTOMATICALLY MATCH AND IMPORT NO OPERATOR CLICK, REMEMBER WHAT THE LATEST EXIF IMPORT WAS AND START FROM AFTER THAT"

92. [2026-04-26/CompSyncElectronApp.md|L2074|20:57:37 EDT] "AND TO INCIDENT REPORT WE NEED SOE SORT OF ALERT IF NO PHOTOS ARE FLOWIGN LIKE THIS"

93. [2026-04-26/CompSyncElectronApp.md|L2103|21:01:38 EDT] "app is saying no jpgs found in the trasnfer folder on manual ITS BUGGED"

94. [2026-04-26/CompSyncElectronApp.md|L2222|21:07:53 EDT] "its still saying no jpgs found even though they're ther"

95. [2026-04-26/CompSyncElectronApp.md|L2903|21:55:15 EDT] "But they should have been imported by app"

96. [2026-04-26/CompSyncElectronApp.md|L4186|23:32:04 EDT] "I also want to add to the incident report. I think a great feature would be a reconciliation as in operator plugs in both SD cards and a manual button press the app. Scans the cards again and make sure that it is already processed all the sequential file names or something. Some way to re-verify that it's up to date up the cards"

97. [2026-04-26/CompSyncElectronApp.md|L4198|23:35:44 EDT] "Currently when we scan the SD do we log the sequential names and exif so we know where to resume the scan next time"

98. [2026-04-26/CompSyncElectronApp.md|L4243|23:38:55 EDT] "I guess it just feels like wasted cycles to scan the entire card every time, which is what I see it doing in the UI at least. Anyways, when we know when our last sequential file name and exif was by the end of the show, there's like 5,000 photos on the card and it just seems like wasted processing"

### Recording / encoding / split / re-record handling

99. [2026-04-24/CompSyncElectronApp.md|L3003|13:44:29 EDT] "data issue occured; 118 and 119 both got recorded into 119s slot ( will need videos/photos fixed)"

100. [2026-04-24/CompSyncElectronApp.md|L3054|13:45:58 EDT] "this coul dhappen again in future and we'll likely need a UI action"

101. [2026-04-24/CompSyncElectronApp.md|L3065|13:47:26 EDT] "No thats not what happneed; recording stopped/started it didn't just run long"

102. [2026-04-24/CompSyncElectronApp.md|L3079|13:48:05 EDT] "as in operator pressed twice on 118, recorded 118 into 119, then recorded real 119 (over) it, we're non destructive"

103. [2026-04-24/CompSyncElectronApp.md|L4277|15:08:43 EDT] "118 has botched 2s recording
    118 and 119 both got recorded into 119s slot
    136 recording into 139 slot
    139 overtop
    140 recorded into 142
    145 went long and 146 is merged in; FIXED VIDEOS are on Dart Desktop called TXXPerf, TXXXjudge1etc
    plan before fixing"

104. [2026-04-24/CompSyncElectronApp.md|L4316|15:10:24 EDT] "I just said fixed videos for 145 and 146"

105. [2026-04-24/CompSyncElectronApp.md|L4539|15:26:59 EDT] "no jus treprint yoru list with understanding; add 155 may have joined to 156, 156 was extra long recording"

106. [2026-04-24/CompSyncElectronApp.md|L4551|15:29:42 EDT] "reveiiwing manually; 155 looks clena"

107. [2026-04-24/CompSyncElectronApp.md|L4566|15:29:53 EDT] "need to see 156"

108. [2026-04-24/CompSyncElectronApp.md|L4786|15:34:09 EDT] "ok a routines was ADDED; we need a row for 155.5 details incoming"

109. [2026-04-24/CompSyncElectronApp.md|L6385|17:10:45 EDT] "did video record windows get screwed up around 147? thats where we had operator errors affecting the video recording stop/starts"

110. [2026-04-24/CompSyncElectronApp.md|L8036|19:19:40 EDT] "those routines you have instructions for they're in the ARCHIVE folder per routine 118 and 119 both got recorded into 119s slot"

111. [2026-04-24/CompSyncElectronApp.md|L8085|19:23:28 EDT] "not sure if htey got their splits/fixed video start/stops yet"

112. [2026-04-24/CompSyncElectronApp.md|L8146|19:30:40 EDT] "So those routines didn't have them run long and need to be split. The whole complete routine is in the archive folder. It needs to be inserted into the slot. Explain what you will do"

113. [2026-04-24/CompSyncElectronApp.md|L8248|19:47:38 EDT] "You need to move slowly here. This is sensitive data. We cannot lose any recordings"

114. [2026-04-24/CompSyncElectronApp.md|L8272|19:51:36 EDT] "Okay, so if 118 is 5 minutes 40 seconds long, it is highly likely that it contains both routines, in which case they'll need to be split and judge videos extracted. It is likely right around the middle and we have a protocol for this that involves transcribing the audio listening for the judge announcement, but I'm not sure if that's available locally on the machine nor can we run it on that machine. I wonder if you could pull out the audio track for that whole long file. Get it to spy balloon. ..."

115. [2026-04-24/CompSyncElectronApp.md|L8286|19:54:02 EDT] "Yes, if you get the audio track from the performance video and transcribe it, you will clearly see the judge announce routine 119. But then you need to apply the encoding step that the app does to split the audio tracks to get the four video cluster"

116. [2026-04-24/CompSyncElectronApp.md|L8329|19:56:31 EDT] "I wonder if it's less load on dart to get the MKV off of it and run it on spy balloon"

117. [2026-04-25/CompSyncElectronApp.md|L4253|16:05:24 EDT] "Yes we need more changes, the flow when recording a slot is confusing and doesn't work"

118. [2026-04-25/CompSyncElectronApp.md|L4261|16:06:06 EDT] "prompts to advance are glitchy, i had recorded over 354 and when i said advance to next it jumped to 356)"

119. [2026-04-25/CompSyncElectronApp.md|L5459|17:11:26 EDT] "Can you queue the re record fixes, it's caused a big mess at end of this session"

120. [2026-04-25/CompSyncElectronApp.md|L5517|17:17:02 EDT] "I know, but it's very very confusing for the user."

121. [2026-04-25/CompSyncElectronApp.md|L5578|17:19:01 EDT] "This also has a issue with a 5 routine not being updated in our data but the other fixes should reference it"

122. [2026-04-25/CompSyncElectronApp.md|L5598|17:23:53 EDT] "9:56 am, 5 routine is a .5 routine as in 399.5 which may not exist in our data which is the different issue."

123. [2026-04-25/CompSyncElectronApp.md|L6230|18:45:28 EDT] "Can we replace SCRATCH button with a green START EMPTY ROUTINE which starts recording in an empty routine slot with saved timestamp snd video time codes"

124. [2026-04-25/CompSyncElectronApp.md|L6247|18:46:28 EDT] "And i mean the scratch button below next button in CSE"

125. [2026-04-25/CompSyncElectronApp.md|L6249|18:46:28 EDT] "Not the in row scratch"

126. [2026-04-25/CompSyncElectronApp.md|L6264|18:47:40 EDT] "Empty routine model may already exist check"

127. [2026-04-25/CompSyncElectronApp.md|L6213|18:38:21 EDT] "1. 399 most recent is 398"
   Context: routine numbering / re-record drift in the schedule.

128. [2026-04-25/CompSyncElectronApp.md|L7138|20:12:57 EDT] "also confirm drag/dropped rows will properly assign UUID entry #s to their proper media online still? It should JUST affect the CSE RECORD ORDER not change routine # or portal order and mix up routines"

129. [2026-04-26/CompSyncElectronApp.md|L1434|17:04:14 EDT] "Okay, this will be a deferred change, but I want to change the behavior of how recording over a routine slot works"

130. [2026-04-26/CompSyncElectronApp.md|L1462|17:19:37 EDT] "So what we're learning in the battlefield is The confirmation modal are confusing for the operator, and typically the latest recording on a routine will be the correct one that should be promoted and be in the visible slot online"

131. [2026-04-26/CompSyncElectronApp.md|L1475|17:29:14 EDT] "I'm going to need to see these questions just one at a time to answer them all. But I like the idea of a Cascade to a Max of one Cascade at which point that routine just gets stashed as a extra routine"

132. [2026-04-26/CompSyncElectronApp.md|L1498|17:34:03 EDT] "If photos have been exif matched to a routines start and stop time then those are the photos for that routine and need to stay linked"

133. [2026-04-26/CompSyncElectronApp.md|L1508|17:37:36 EDT] "This might be a larger question about accidental records"

134. [2026-04-26/CompSyncElectronApp.md|L1527|17:56:44 EDT] "I like the auto stash at 30 seconds with a timer letting the operator know that if they don't act, it'll be stashed safely. We do already have extra recording feature and they are all stored at the very bottom of the schedule which is a good place for them. We might want to add a button on stashed extra recordings like this where the operator can hit, edit and enter in at least a routine number and possibly a title as well as any additional notes. And if we want to make a note that the CD dashbo..."

135. [2026-04-26/CompSyncElectronApp.md|L1534|17:58:54 EDT] "Photos need to go with the time window that is canonical truth for matching photos to a routine. It never exists. That routines have different video recording windows than their photos and if it does happen we will have known and accounted for that time offset otherwise"

136. [2026-04-26/CompSyncElectronApp.md|L1544|17:59:38 EDT] "Of course we need safety that no photos are ever removed or deleted even if they don't match because they might match later once we account for offset etc"

137. [2026-04-26/CompSyncElectronApp.md|L1557|18:03:45 EDT] "Any takes time window needs to stay canonical. We might want to shift around what the entry number is etc. But we never want to modify the actual start and end time of the recording. That's how we do all the processing later"

138. [2026-04-26/CompSyncElectronApp.md|L1569|18:07:35 EDT] "Yes, assure them non-blocking let them know afterwards. They'll be asked to decide where something goes and automatically disappear in 5 seconds with a countdown"

139. [2026-04-26/CompSyncElectronApp.md|L1599|18:17:13 EDT] "Ideally I want expandable rows for there to be a little arrow on each row and when you click down on the arrow, it'll expand to show the routines video photos as well as options to reassign the routine based on the same logic we're building"

140. [2026-04-26/CompSyncElectronApp.md|L1617|18:26:02 EDT] "As a routine starts reporting, I don't want the operator to have to make the decision. Then they can use the modal to decide what goes where"

141. [2026-04-26/CompSyncElectronApp.md|L1628|18:32:04 EDT] "Pre-Record toast can say recording already exists for this routine record again? Nothing is overwritten and you'll be asked to decide what goes where upon stopping"

142. [2026-04-27/CompSyncElectronApp.md|L297|14:45:00 EDT] "I want to add to the debrief that right now or at the last competition rerecording into a slot creates a massive issue for the photo matching so I just want to make sure when we do any sort of extra routine recording or recording over a slot that video timestamps are preserved and the photo matching is intelligent to catch it It's making a massive mess right now"

143. [2026-04-27/CompSyncElectronApp.md|L378|14:51:15 EDT] "Also just want to make sure that we have a strict photo per routine rule i'm noticing duplication and a photo should never be assigned to two RO routines The business logic is strict and grounded here A photo should only ever exist in one routine as it was taken during that routine and couldn't be taken at two different routine times if the matching logic is assigning it to two routines then there's something off about the timestamps et cetera"

144. [2026-04-27/CompSyncElectronApp.md|L426|16:01:30 EDT] "and we need to make sure elec app queue is cleared/invladidated What tends to happen is we finished the competition and then do a bunch of manual fixing and we never want the app state to override the DB state"

145. [2026-04-27/CompSyncElectronApp.md|L486|16:05:43 EDT] "i'm worrried about my just note about state... i meant more just now we need the queeue cleared or a way to clear the qeue eon startup so we dont have posining when a lot of post-event fixes are made"

146. [2026-04-27/CompSyncElectronApp.md|L547|16:23:10 EDT] "if a routine is SCATCHED in elecapp we want it to be marked SCRATCHED in media portal"

### Stream Deck / hardware controls

147. [2026-04-25/CompSyncElectronApp.md|L3417|14:53:05 EDT] "Next button on stream deck did not flash at 2 minutes 20 seconds"

148. [2026-04-25/CompSyncElectronApp.md|L3527|15:01:56 EDT] "Steam deck button not flashing still"

149. [2026-04-25/CompSyncElectronApp.md|L3755|15:17:14 EDT] "Next flash can be from minute 2 instead 220"

150. [2026-04-25/CompSyncElectronApp.md|L7248|20:20:11 EDT] "we added a custom change transition button to stream deck earlier remember?"

151. [2026-04-25/CompSyncElectronApp.md|L7264|20:21:06 EDT] "I'm wondering if it could have an effect/color PER set transition? We like using stingers but often forget to change it from stinger to cut, I'd like the STIGNER transition to have a glowing red box around it after the first fire? Psossible?"

152. [2026-04-25/CompSyncElectronApp.md|L7309|20:22:39 EDT] "yes kind; and actually could it be wired so after its fired once it switches to cut?"

153. [2026-04-25/CompSyncElectronApp.md|L7927|20:58:21 EDT] "and the stream deck should allow selection of stinger; allow fire, allow full transition to play out ~5s, then SWITCH TO CUT after"

154. [2026-04-25/CompSyncElectronApp.md|L9335|22:29:08 EDT] "The stream deck buttons are now all green out of comp sync"

155. [2026-04-25/CompSyncElectronApp.md|L9585|22:36:10 EDT] "Just describe what you found. Did something in the ASAR break the stream deck"

156. [2026-04-25/CompSyncElectronApp.md|L9593|22:37:45 EDT] "So the show is live right now. It's easy to restart the stream deck app but difficult to restart. CSE so I would like confirmation that the asar indeed broke the stream plug-in. If you could just fix the plug-in that would be much easier"

157. [2026-04-25/CompSyncElectronApp.md|L9601|22:39:36 EDT] "Just roll it back"

158. [2026-04-25/CompSyncElectronApp.md|L6573|19:20:39 EDT] "And NEXT button on Elec app can have same flash pattern as steam deck button"

### Overlay / lower third / chat / branding

159. [2026-04-24/CompSyncElectronApp.md|L1792|12:26:58 EDT] "yes i want break info there an dwhat are these errors [App] [Renderer] [METER-DIAG #22700] computed={\"performance\":-21.031796250818978,\"judges\":[-42.14063717883625,-40.23334624340005,-20.99013307836231]} (file:///C:/Program%20Files/CompSync%20Media/resources/app.asar/out/renderer/assets/global-DuVGFFpW.js:7439) ... [main] [App] [Renderer] [METER-DIAG #22700] levels=6 mapping={\"performance\":\"Perf\",\"judge1\":\"Judge1\",\"judge2\":\"Judge2\",\"judge3\":\"Judge3\",\"judge4\":\"\"} sample=[{\"inputName\":\"..."

160. [2026-04-24/CompSyncElectronApp.md|L8367|20:00:16 EDT] "The lower third is still glitching all over the place. When it fires via the next action, it seems to work for a handful of routines and then eventually starts flashing all over the place. We've tried to fix this in several commits"

161. [2026-04-25/CompSyncElectronApp.md|L4279|16:07:19 EDT] "Also I just tested live chat and it still doesn't work. I don't see messages in app, it's a supabase real time setup"

162. [2026-04-25/CompSyncElectronApp.md|L4395|16:11:06 EDT] "We had setup persistence prior are you sure"

163. [2026-04-25/CompSyncElectronApp.md|L4444|16:14:49 EDT] "I just tested it so there are definitely user messages"

164. [2026-04-25/CompSyncElectronApp.md|L4980|16:45:39 EDT] "I just tested and can't see in app"

165. [2026-04-25/CompSyncElectronApp.md|L5065|16:49:03 EDT] "But i just sent a Deb test message just now and don't see in app"

166. [2026-04-25/CompSyncElectronApp.md|L5298|17:02:34 EDT] "Also, I'm testing the pinning of the diagnostic chats and it's not working"

167. [2026-04-25/CompSyncElectronApp.md|L5453|17:08:37 EDT] "I'm ok to keep position, but it didn't seem to fire before I'll check again"

168. [2026-04-25/CompSyncElectronApp.md|L5683|17:40:16 EDT] "Start coding fixes, browser source was refreshes before test, landing out of camvas maybe?"

169. [2026-04-25/CompSyncElectronApp.md|L5929|18:13:37 EDT] "Just testing the chat pinning right now and I'm seeing messages in the app now that are put on the web portal, but pinning still does nothing on screen"

170. [2026-04-25/CompSyncElectronApp.md|L6379|19:01:31 EDT] "Noticed that there's no chat pin option in the overlay editor if that's a clue"

171. [2026-04-25/CompSyncElectronApp.md|L6571|19:20:39 EDT] "Chat fix?"

172. [2026-04-25/CompSyncElectronApp.md|L6924|19:48:24 EDT] "And the other overload.... Still too many photo modals"

173. [2026-04-25/CompSyncElectronApp.md|L7793|20:54:05 EDT] "could you ad a quick CHAT AS ADMIN windwo below the chat so we can reply to the chat from in the app"

174. [2026-04-25/CompSyncElectronApp.md|L8003|21:04:15 EDT] "tested a real chat, didn't work, doesnt work in editor either"

175. [2026-04-25/CompSyncElectronApp.md|L8039|21:05:59 EDT] "and there no respond as admin option in the chat window on CSE"

176. [2026-04-25/CompSyncElectronApp.md|L8154|21:12:13 EDT] "but the test chat doesn't even fire in our previe"

177. [2026-04-25/CompSyncElectronApp.md|L8919|21:50:57 EDT] "ok chat pins firing but we dont want yellow we want matching brand purple"

### Misc CSE app behavior, modals, audio, UI

178. [2026-04-23/CompSyncElectronApp.md|L223|20:10:04 EDT] "Just tried to load and got fetch failed in the app. Do you're getting access refresh then find out why"

179. [2026-04-23/CompSyncElectronApp.md|L1115|23:12:13 EDT] "I'm interested in serving a mobile page that the photographer can use to keep his camera in sync with dart"

180. [2026-04-23/CompSyncElectronApp.md|L1123|23:21:43 EDT] "I just want a website to give to the photographer that has comp sync routing that's pulling the system time from dart that they can just load on their phone when given the link"

181. [2026-04-24/CompSyncElectronApp.md|L1426|10:51:16 EDT] "Everything pushed from last night successfully. Show starts in 70 minutes. What should I check in the limited time we have"

182. [2026-04-24/CompSyncElectronApp.md|L3312|14:07:07 EDT] "More notes from current build All rows say portal none even with uploads working
    Tablet keeps losing display not touch
    Tablet button doesn't fix it in app but should"

183. [2026-04-24/CompSyncElectronApp.md|L5047|16:09:37 EDT] "what is this erro [IPC] clip:verify-import failed: Load model from C:\\Program Files\\CompSync Media\\resources\\app.asar\\node_modules\\@huggingface\\transformers\\.cache\\Xenova\\clip-vit-base-patch32\\onnx\\vision_model.onnx failed:Load model C:\\Program Files\\CompSync Media\\resources\\app.asar\\node_modules\\@huggingface\\transformers\\.cache\\Xenova\\clip-vit-base-patch32\\onnx\\vision_model.onnx failed. File doesn't exist and you nee to finish the cdd work"

184. [2026-04-24/CompSyncElectronApp.md|L7124|18:02:16 EDT] "Ok got to back up with a forced start"

185. [2026-04-25/CompSyncElectronApp.md|L3|01:01:03 EDT] "Okay, I need all of the closing. The show checklist pulled out just as a message that I can send"

186. [2026-04-25/CompSyncElectronApp.md|L31|01:17:21 EDT] "No. The operator closing modal notes like put in the cameras away and charging them etc. They should already exist within the app inside a modal"

187. [2026-04-25/CompSyncElectronApp.md|L133|02:20:44 EDT] "Let's start a list of changes for the app for tomorrow. Let's put some sort of closed confirmation on the app that says there are still jobs running like uploads etc. And recommend it to leave the app open"

188. [2026-04-25/CompSyncElectronApp.md|L309|02:33:46 EDT] "Item one yes, I think it should count for anything from importing through encoding to uploading warn the user that the app is intended to finish all jobs before closing. But the job queue will resume on restart Make sure it's really easy to just click to close as will but still be closing it with jobs running in the day"

189. [2026-04-25/CompSyncElectronApp.md|L3717|15:12:41 EDT] "Will current app auto skip scratched routines on NEXT"

190. [2026-04-25/CompSyncElectronApp.md|L3786|15:18:53 EDT] "Routine rows say portal complete even when photos aren't upload"

191. [2026-04-25/CompSyncElectronApp.md|L3853|15:36:37 EDT] "Investigate, dual counter numbers came back"

192. [2026-04-25/CompSyncElectronApp.md|L3889|15:38:13 EDT] "Wonder if instead it can say NEXT AWARDS which is the time after the last routine in a session when a BREAK IS"

193. [2026-04-25/CompSyncElectronApp.md|L3945|15:41:52 EDT] "Last session of day needs it to, infer from after last routine"

194. [2026-04-25/CompSyncElectronApp.md|L4035|15:48:56 EDT] "Anyway to renove the green checkmark that firea on SD press?"

195. [2026-04-25/CompSyncElectronApp.md|L8261|21:25:11 EDT] "why is dart cpu so hi"

196. [2026-04-25/CompSyncElectronApp.md|L8979|21:58:11 EDT] "still to many modals on startup"

197. [2026-04-25/CompSyncElectronApp.md|L9759|23:21:15 EDT] "So around a just before halfway nto a session we need the operators to swap SD cards, they keep forgetting. I want to add a line in the row where that would occur in a clear heads-up for them? The app doesn't need to take any action. It's just for the operator to read"

198. [2026-04-25/CompSyncElectronApp.md|L9801|23:23:07 EDT] "Will need to make sure it doesn't interfere with any routine recording, logic etc"

199. [2026-04-26/CompSyncElectronApp.md|L1351|12:54:36 EDT] "Dart cpu seems high too long check machine logs?"

200. [2026-04-26/CompSyncElectronApp.md|L1679|20:28:55 EDT] "uploads seem stalle don machine?"

201. [2026-04-28/CompSyncElectronApp.md|L191|13:10:12 EDT] "When we split a routine in the encoding process into the four videos, what happens to the original MKV with all four audio tracks"

202. [2026-04-28/CompSyncElectronApp.md|L860|14:32:27 EDT] "Using the next button or clicking on a routine row any single next recording after the manual nudge should go back to programmatic but nudge is allowed again the counter nudge needs hey type in field up near the recording controls so it should be a button to say override counter you click the button type in the number and the counter number is overwritten and then it resets on next recording"

203. [2026-04-28/CompSyncElectronApp.md|L874|14:36:56 EDT] "Just flip the note but we need to have some kind of feel to remember what the counter was set to because that will likely be the ground truth of what actual routine it is"

204. [2026-04-28/CompSyncElectronApp.md|L882|14:37:19 EDT] "And we can never block the start of a recording I would say don't enforce or pop up a modal after the routine just make a ersistent note of what the operator typed in"

205. [2026-04-28/CompSyncElectronApp.md|L926|14:43:43 EDT] "I didn't think this was ADB level fix I thought this was a EXIF matching fix as in when routines are imported inside the electron app they can't be assigned to more than one routine Explore this please"

206. [2026-04-28/CompSyncElectronApp.md|L1042|15:00:06 EDT] "NO we dont need text input on scratch"

207. [2026-04-28/CompSyncElectronApp.md|L1076|15:02:10 EDT] "We don't need a re record button on the audio silent banner This is hallucinated"

---

## B. CompPortal media sorting / matching / display issues

1. [2026-04-23/CompSyncElectronApp.md|L302|20:38:43 EDT] "retool https://udc.compsync.net/dashboard/admin/livestream to be rich single page no scroll all info"

2. [2026-04-24/CompSyncElectronApp.md|L133|00:26:29 EDT] "recent events on https://udc.compsync.net/dashboard/admin/livestream needs be smaller/way more rows of data/events"

3. [2026-04-24/CompSyncElectronApp.md|L1694|12:10:51 EDT] "ok on https://udc.compsync.net/dashboard/admin/livestream i want way more rows in <h3 class=\"...\">Recent Events</h3>, i dont want the chat backfill viewable here. APP LIVE IN SHOW MODE NOW"

4. [2026-04-24/CompSyncElectronApp.md|L1764|12:13:47 EDT] "my issue with RECENT EVENTS panel is its too short to show rows, COMAND history can be smaller Recent events prioritiied"

5. [2026-04-24/CompSyncElectronApp.md|L1780|12:25:40 EDT] "i dont see the inferred breaks on https://udc.compsync.net/dashboard/director-panel/media; are they im the electron app? APP IS LIVE IN PRODUCTION"

6. [2026-04-24/CompSyncElectronApp.md|L1908|12:45:48 EDT] "still not seeing breaks <h3 class=\"...\">Routines (574)</h3>"

7. [2026-04-24/CompSyncElectronApp.md|L2040|13:00:04 EDT] "uploads flowing? my \"logs\" should be human redble on http://udc.compsync.net/dashboard/admin/livestream maybe uploadin gmeter/inmport meter/encoding meter etc, think throguh it so its more useful"

8. [2026-04-24/CompSyncElectronApp.md|L2301|13:18:24 EDT] "did you add this <td colspan=\"10\" ...><span>— Fri, Apr 24 · Session 1 —</span></td> to CD portal? I diddn't ask for this; i meant on the MACIEN page of <button ...>Machine</button><h3 ...>Routines (574)</h3> https://udc.compsync.net/dashboard/admin/li..."

9. [2026-04-24/CompSyncElectronApp.md|L5296|16:15:35 EDT] "https://udc.compsync.net/dashboard/admin/livestream dashboard needs more feature parity and full CSE app visibility; eg i cant see if SD is in, what state of recording is (recording couner etc) make a plan, ONLY WANT TO CHANGE COMPPORTAL right now"

10. [2026-04-25/CompPortal.md|L444|16:10:33 EDT] "What is state of media/rows for Toronto? CD dashboard seems of in the VISIBILITY counts"

11. [2026-04-25/CompPortal.md|L504|16:12:47 EDT] "I mean the visibility publish settings in the CD dash embedded in competition filters"

12. [2026-04-25/CompPortal.md|L541|16:14:08 EDT] "But the counts need to be synced to real media"

13. [2026-04-25/CompPortal.md|L645|16:22:36 EDT] "Can these be setup to stay in sync"

14. [2026-04-25/CompPortal.md|L1156|20:32:49 EDT] "https://udc.compsync.net/dashboard/admin/livestream i can still use more state-sync with the CSE app; whether recording is on, ❯ i still wnat more HUMAN READBEL RECENT EVENTS in https://udc.compsync.net/dashboard/admin/livestream wiht raw log option, as well as more events, and chat window is broken, we just did persistence work on"

15. [2026-04-25/CompPortal.md|L1242|20:36:30 EDT] "and chat needs moderation features where possible"

16. [2026-04-25/CompPortal.md|L1256|20:38:35 EDT] "yes; and is it possible for delete chat to INSTANTLY delete from the panel?"

17. [2026-04-25/CompPortal.md|L1511|21:10:00 EDT] "i dont see recoding pilll does it only show when recording? I'd rather RECORDING satus to be clear either way"

18. [2026-04-25/CompPortal.md|L1535|21:30:45 EDT] "and can the buttons like rec/stream glow"

19. [2026-04-26/CompSyncElectronApp.md|L54|02:02:34 EDT] "Online portal is showing no videos since 167?"

20. [2026-04-26/CompSyncElectronApp.md|L305|02:18:09 EDT] "Looks like it's isolated to 167 to 311"

21. [2026-04-26/CompSyncElectronApp.md|L307|02:18:09 EDT] "So you need to find those video clusters make sure they're the right ones and relink them so they're visible in the CD portal. They were never deleted or removed from r2, but you may have broke the linking when you earlier cleaned up up the db-r2 linking but they should all exist as their entry numbers"

22. [2026-04-26/CompSyncElectronApp.md|L387|02:43:38 EDT] "Something happened to the videos for routine One 67 through 311 at the UDC Toronto competition they exist on the disk and dart but they need to be properly uploaded to R2 and then matched correctly via DB etc so they appear in the CD portal exactly the same as the other routines"

23. [2026-04-26/CompPortal.md|L19|11:29:29 EDT] "? I asked for a mobile audit"

24. [2026-04-26/CompPortal.md|L77|11:33:24 EDT] "Revamp a mobile friendly don't affect desktop"

25. [2026-04-26/CompPortal.md|L262|11:44:50 EDT] "Where did we end up with the CD media dashboard section where this birthday etc could be managed? I thought we had a plan replace"

26. [2026-04-26/CompPortal.md|L541|11:52:28 EDT] "But cs support never made it to MEDIA dashboard just main"

27. [2026-04-26/CompPortal.md|L555|11:53:29 EDT] "And we need to make sure that all fields on an answer are editable and save. We've had issues in the past with errors etc. Being thrown CD needs to have basically SA level crud ability for all dancers, routines scheudles etc. in this case, it'll just be for dancers, but we've had issues in the past with Prisma errors and permissions issues"

28. [2026-04-26/CompPortal.md|L831|12:31:33 EDT] "What no i said additive not replace"

29. [2026-04-26/CompPortal.md|L1147|14:11:23 EDT] "Recommend optimization pass?"

30. [2026-04-26/CompPortal.md|L1158|14:13:30 EDT] "I don't want massive API calls using the modal and we need an audit log"

31. [2026-04-26/CompPortal.md|L1297|16:02:42 EDT] "I need a clean png of the media link qr code available on venue TV page"

32. [2026-04-26/CompPortal.md|L1430|16:46:29 EDT] "Also have a magic bulk update feature that I don't believe is active for medium. Only CDs yet but it is on the native CD dashboard"

33. [2026-04-26/CompPortal.md|L1493|17:02:30 EDT] "I want to drill down a bit on the CD media dashboard. I want the media review feature to filter by the actively selected competition and in general I want to actively selected competition to persist across sessions until it's changed by the CD and I still want the filter to be removable but CD typically works on one competition at a time and just wants to see that competition is media when they log in and out"

34. [2026-04-26/CompPortal.md|L1533|17:09:01 EDT] "The dashboard should always load for these filters selected and remember the last filter and it should pass that filter to subsequent pages like the social media helper and verify media. We should also have a click on active filter to remove filter so the CD can look at everything across all competitions but that state shouldn't persist if the CD logs out and logs back in it should go back to picking the latest competition"

35. [2026-04-26/CompPortal.md|L1553|17:09:51 EDT] "I also want a flag that we had some media at the London competition that didn't have any videos and the verify modal didn't capture it and that would be the intent of the modal. I believe we have a zero photos, zero videos checker that may have failed"

36. [2026-04-26/CompPortal.md|L1728|17:42:35 EDT] "No, I don't want to do actual data work in this session. I just want you to add that as a check in the verify media modal"

37. [2026-04-26/CompPortal.md|L1903|17:53:07 EDT] "Yes and I would like to have a way for the verify to not call critical or errors on routines that have yet to have even danced so not to throw these errors on complete routines I guess"

38. [2026-04-26/CompPortal.md|L2179|18:09:20 EDT] "I don't understand if the parser is confused about what studio etc. Are catch-all is that there's this confirmation modal that pops up similar to the bulk update pattern. So there's no danger because the confirmation modal should show the dancer and the studio or show options and the CD can select the appropriate option and select do nothing on ones that are not the appropriate option"

39. [2026-04-26/CompPortal.md|L2539|19:21:24 EDT] "ok but why are all udc toronto statuses set to CMPLETE? When a bunch haven't danced? Dont chagne just chek"

40. [2026-04-26/CompPortal.md|L2588|19:23:21 EDT] "i'm checking UI and CD dash shows complete for all TO routines even though many have yet to perform, therefore they're showing as errored in the pciker"

41. [2026-04-26/CompPortal.md|L2614|19:26:02 EDT] "who sets COMPLETE? Does the compsyncelectronapp?"

42. [2026-04-26/CompPortal.md|L2649|19:27:32 EDT] "ok i need you to work out to make sure the statuses get properly updated in flow before we set the others back to pending, dont do wihtout my go"

43. [2026-04-26/CompPortal.md|L2669|19:22:21 EDT] "does confiramtion show all CURRENT INFO and the propse dchange?"

44. [2026-04-26/CompPortal.md|L2686|19:25:08 EDT] "i dont want references to BULK UPDATE in this flow; just a confirmation modal. Also I don't want CD to have to pick competition/studio etc; i want the modal to pop up with options of what to change"

45. [2026-04-26/CompPortal.md|L2744|19:30:35 EDT] "i think PENDING until all media in then CMPLETE and verify should filter out PENDING so it only scans COMPLETE"

46. [2026-04-26/CompPortal.md|L2758|19:31:46 EDT] "video keyframes i sa red herrign i think... are all keyframes genned for toronto except the last ~50?"

47. [2026-04-26/CompPortal.md|L2775|19:32:41 EDT] "hmmm actually i can see here that routines are marked COMPLETE with all 4 videos and no photos"

48. [2026-04-26/CompPortal.md|L2797|19:33:28 EDT] "tel me more about missing keyframes and same perofrmance time; note we have 2 scheudle version data"

49. [2026-04-26/CompPortal.md|L2841|19:36:10 EDT] "yes lets do that. so TO doesn't have all entries as that 13:11?"

50. [2026-04-26/CompPortal.md|L3033|19:37:25 EDT] "does CD dash currently show first 3 adn last 3 in each row pictureS?"

51. [2026-04-26/CompPortal.md|L3106|19:42:32 EDT] "119 video is wrong; the real video should start at current 2:35 of current video to the end o fcurrent video. 118 may have some weird broken links in its photo. I'm going to put it some more but start building fix plan (this one will involve a ffmpeg split/reupload)"

52. [2026-04-26/CompPortal.md|L3201|19:51:41 EDT] "145 and 146 were supposed to reuploaded from Dart desktop, 146 looks good but 145 looks like it didnt get its shortened videos which are still on dart dekstop, and more ghost rows here that need cleanup"

53. [2026-04-26/CompPortal.md|L3248|19:53:48 EDT] "im getting this erro trying to move in 155.5 (this was an added routine)"

54. [2026-04-26/CompPortal.md|L3374|20:00:30 EDT] "exif is jumbled up around 355, wrong photos in 354, 355 is mising photos"

55. [2026-04-26/CompPortal.md|L3417|20:03:30 EDT] "379 doesn't seem to have neough photos"

56. [2026-04-26/CompPortal.md|L3450|20:06:46 EDT] "you have creds in find auth; pull routines out of dart and work on spyballoon path is DESKTOP/TESTEROUTPUT/UDCTORONTO. Are you including a TO-wide Ghost scan?"

57. [2026-04-26/CompPortal.md|L3578|20:23:31 EDT] "chat timestamp text on https://udc.compsync.net/dashboard/admin/livestream is unreadbly dark"

58. [2026-04-26/CompPortal.md|L3913|20:33:55 EDT] "fix the bug, 145 had the ghosts last"

59. [2026-04-26/CompPortal.md|L3943|20:36:24 EDT] "145 still isn't trimmed where did that item go"

60. [2026-04-26/CompPortal.md|L4033|21:08:28 EDT] "10. you do I gave yo uthe cut point 3:03"

61. [2026-04-26/CompPortal.md|L4562|23:02:18 EDT] "That doesn't seem right. There are not 56 ghost photos anywhere. Open up some and look at them"

62. [2026-04-26/CompPortal.md|L4747|23:22:01 EDT] "As in, you've identified 3,300 photos that exactly match where they should be except they're off by 4:00 hours"

63. [2026-04-26/CompPortal.md|L4758|23:22:59 EDT] "Can you sample 10 routines in that data set? Look at their video keyframes and compare them to photos to confirm your hypothesis"

64. [2026-04-26/CompPortal.md|L4890|23:33:30 EDT] "I mean the manual moves I did were real fixes from where it looked like the record button was pressed late"

65. [2026-04-26/CompPortal.md|L4910|23:37:02 EDT] "I guess based on that manual move list and other routines that has been fixed in this session and my notes that I gave you, I want to have a list of routines to check manually"

66. [2026-04-27/CompPortal.md|L67|01:46:33 EDT] "So I guess I want to finish the media verification tools that we started already building which involve image reading and recognition because the core things we need to verify are one that the video keyframes match the photo and two that the subject of the photoset doesn't suddenly change and this will be most susceptible on the edges of the routine We already built a flow for this but it wasn't completely finished and I want to get that working"

67. [2026-04-27/CompPortal.md|L169|01:57:25 EDT] "but check the verify media modal those aren't live"

68. [2026-04-27/CompPortal.md|L286|02:10:58 EDT] "lets just find these photos 130    CAN YOU DO THIS?    Studio One Dance Academy    0 photos · has video"

69. [2026-04-27/CompPortal.md|L587|02:58:09 EDT] "theres never 2 cameras; its likely 2 routines"

70. [2026-04-27/CompPortal.md|L589|02:58:09 EDT] "we could add to verify modal; look for photos assigned to 2 routines"

71. [2026-04-27/CompPortal.md|L591|02:58:09 EDT] "photos only ever belong to 1"

72. [2026-04-27/CompPortal.md|L782|03:12:59 EDT] "wait what other checks have i flaggeD? no videos longer than >3:30 (likely 2 routines) and i thought i said others"

73. [2026-04-27/CompPortal.md|L911|03:24:29 EDT] "no the top right counter isn't ground truth, it will be wrong for some routines, including likely on the list; but make 2 feature sugestions to CSE app inbox; 1 is the operator should be able to manually nudge the top right counter to force it match the intended routine so this ocr can work (but it needs to programmatically be set back on the next fire routine) and the better keyframe gen"

74. [2026-04-27/CompPortal.md|L963|03:26:30 EDT] "i think part of hte WRONG SUBJECT scan should include; once wrong subejct identified, check neighbours keyframes and look for easy moves to execute"

75. [2026-04-27/CompPortal.md|L997|03:31:02 EDT] "oh and the routines that show excessive phtoos should be scanned for subject changing with their neighbours as well"

76. [2026-04-27/CompPortal.md|L1029|03:36:24 EDT] "oh and add to CSE inbox that the operator counter nudge should auto trigger a flag on that routine, prompt a note from operator, and that notes shoudl be considered int eh veirfy media check"

77. [2026-04-27/CompPortal.md|L1632|14:15:14 EDT] "yes in the visitbiltiy modal; add an expected date/time and that will show to users; 12hr EST please"

78. [2026-04-27/CompPortal.md|L1897|14:16:57 EDT] "why doe tester.compsync.net throw https://tester.compsync.net/"

79. [2026-04-27/CompPortal.md|L1982|14:18:30 EDT] "yes just the broken thumbnails see whats going on, count shows 131"

80. [2026-04-27/CompPortal.md|L2547|14:34:11 EDT] "i believe all phtoos are uploaded; can you check r2 for clean sequential ordering in uploaded jpgs? there shouldn't be any gian tmissing clusters"

81. [2026-04-27/CompPortal.md|L2598|14:46:57 EDT] "and that modal is branded properly no white on white background or dropdowns?"

82. [2026-04-27/CompPortal.md|L2600|14:47:32 EDT] "And that has proper branding no white on white drop downs or blank background etc"

83. [2026-04-27/CompPortal.md|L2739|14:55:34 EDT] "So a couple things moving a large amount of photos seems to lock up and block the function it seems to work OK with up to 15 photos or So what if I try to move 50 or 60 photos it just hangs and doesn't end up doing the move also when I complete a move of photos the whole page jumps to the routine that I moved to I would prefer it just to move the photos and then refresh still so I see the move take lace but stay on the routine that I'm on"

84. [2026-04-27/CompPortal.md|L2859|14:48:46 EDT] "OK so if no giant gaps exist then I just want the broken thumbnails that are linked to any broken photos just removed from visibility to users if we could do this non destructively it would be great I just need all the broken thumbnail appearing items removed competition wide just focus on UDC Toronto"

85. [2026-04-27/CompPortal.md|L2900|14:52:28 EDT] "Are we sure the server side thumbnail generation works I just tried the UI button and it didn't seem to work"

86. [2026-04-27/CompPortal.md|L2927|14:54:52 EDT] "The 118 videos looked OK but the 119 performance video was trimmed but I needed that trim to happen across the three judge videos as well with their correct audio tracks and you also need to regenerate the thumbnails"

87. [2026-04-27/CompPortal.md|L3162|15:23:24 EDT] "also can typing an etnry into entry \"filter\" JUMP TO THAT ENTRY and not FILTER it?"

88. [2026-04-27/CompPortal.md|L3192|15:25:26 EDT] "ab, and the MOVE button which MOVES WHOLE ROUTINE is not needed; we're only ever moving indindiaul pieces; that button should allow the SELCTED PHTOSO to be moved not move everytyhing"

89. [2026-04-27/CompPortal.md|L3206|15:19:56 EDT] "i'm just legit missing 353.5 I know we recoredd it but cant find its full length anywhere"

90. [2026-04-27/CompPortal.md|L3313|15:29:08 EDT] "no i've seen that; are we sure thats the SOURCE MKV of the recording or could naother exist?"

91. [2026-04-27/CompPortal.md|L3321|15:30:04 EDT] "MOVE TO button, and a speerate NEXT ROUTINE button buttom of modal to easily nav to next rounte (doesn't move anything)"

92. [2026-04-27/CompPortal.md|L3334|15:33:27 EDT] "it should jump on completion of typing the 3rd number for entry. 1 both, 2, yes moving photos should say MOVE TO , nav shoudl just say NEXT/PREV"

93. [2026-04-27/CompPortal.md|L4038|16:00:45 EDT] "we lost our MOVE TO NEXT/PREVIOUS button and trying to move throws /api/media/cd/reassign-photos:1  Failed to load resource: the server responded with a status of 500 ()"

94. [2026-04-27/CompPortal.md|L4146|16:08:39 EDT] "what was the 500 error?"

95. [2026-04-27/CompPortal.md|L4150|16:09:38 EDT] "and we need the VISIBILTY button on each competition filter on CD dash to show the current state UNPUBLISHED/PUBLISHED not jhust VISIBILTY with green/yellow"

96. [2026-04-27/CompPortal.md|L4174|16:12:30 EDT] "Internal server error —"

97. [2026-04-27/CompPortal.md|L4455|16:25:16 EDT] "entry 611's video actuall starts at 2:43 on 612's curent video; need the full 4 set split and reuploaded to 611 spot and linked"

98. [2026-04-27/CompPortal.md|L4522|16:28:21 EDT] "and 612 needs that section removed from it and reuploaded"

99. [2026-04-27/CompPortal.md|L4533|16:28:38 EDT] "never destory original"

100. [2026-04-27/CompPortal.md|L4632|16:43:30 EDT] "also PUBLISHED shoudl have a PARTIAL inddicator if not all 6 vectors are published"

101. [2026-04-27/CompPortal.md|L4713|16:32:39 EDT] "can we spec a SPLIT function that shows in the UI near the videos that lets user enter the cut point, indicate which chunk should go where (chunk1  earlier TC< chunk2 later TC) just like we did here and this is cut automatically? we need ffmpg server side dont we"

102. [2026-04-27/CompPortal.md|L4747|16:36:28 EDT] "needs to operate on the users machine not my hardcoded machine; and needs a modal that shows progress meter and run automacially as possible"

103. [2026-04-27/CompPortal.md|L4765|16:40:44 EDT] "we should offer a QUEUE option to QUEE it up or RUN indivudal; when multipel are cueed CD can step away while they run"

104. [2026-04-27/CompPortal.md|L4824|17:02:17 EDT] "in UPLOAD VIDEO section for videos can we add an UPLOAD ALL and a basic parser for multi sleect videos wehre you can selec 4 videos and the parser will guess perf, j1, j2 etc"

105. [2026-04-27/CompPortal.md|L4886|17:13:48 EDT] "] parser failed on C:\\Users\\danie\\Desktop\\T353.5Perf.mp4 etc needs to be less stuipd"

106. [2026-04-27/CompPortal.md|L4977|17:19:32 EDT] "i had pitched things like duration differences between judege and perf videos?"

107. [2026-04-27/CompPortal.md|L4983|17:20:22 EDT] "gotcha; i want to add cehcking for VIDEOS under 20s length in viewable spots, needs a check"

108. [2026-04-27/CompPortal.md|L4992|17:21:13 EDT] "hmmm yes NO ROUTINE IS EVER UNDER 1min"

109. [2026-04-27/CompPortal.md|L5076|17:27:16 EDT] "indiviudal routine upload photos flow fails with /api/media/cd/upload-photos:1  Failed to load resource: the server responded with a status of 413 ()"

110. [2026-04-27/CompPortal.md|L5153|17:23:31 EDT] "kk we need to find 353.5s photos, between 956-958 am on sd cards mounted on firm"

111. [2026-04-27/CompPortal.md|L5416|17:39:32 EDT] "this looks like the 4hour UTC issue we uncovered check trasncripts; it was from a manual upload; this was supposedly scanned already"

112. [2026-04-27/CompPortal.md|L5418|17:39:32 EDT] "117    HOW TO BE A HEART BREAKER    Jazz Be Nimble    5 photos · 14335s outside"

113. [2026-04-27/CompPortal.md|L5440|17:41:02 EDT] "no i meant manual upload as in via claude code which we dont need to fix the route, just the data; prepare a fix (only the 14ks ones)"

114. [2026-04-27/CompPortal.md|L5505|17:52:42 EDT] "modal sohuld offer quick fixes for things like thumbnails and keyframes"

115. [2026-04-27/CompPortal.md|L5533|17:53:59 EDT] "we have an existing regen thumbnail path manual button on rows"

116. [2026-04-27/CompPortal.md|L5551|17:54:32 EDT] "adn we've specced a user/browser side ffmpeg path for editing videos, could use fro keyframe gen"

117. [2026-04-27/CompPortal.md|L5690|17:49:00 EDT] "i'm looking at r184 from your list; trio of girls in blue. Started 1242 pm. when i look at their photos exif on 1st says 843 am but its the CORRECT DANCERS. photo 97 exif jumps to 1243pm and is still CORECT DANCERS. no incorrect dancers here just strange exifs, 124316 exif photo is a DUPE of 84315 EXIF (those are times)"

118. [2026-04-27/CompPortal.md|L5853|17:56:08 EDT] "Ok if they have different filesnames we need their errored exifs to change to match reality; can we try this with 1 routine thaen scan for all affected before running"

119. [2026-04-27/CompPortal.md|L6170|18:01:35 EDT] "ok 184 looks good, fix for all in that bug class. I'll investiage bug 2"

120. [2026-04-27/CompPortal.md|L6192|18:02:37 EDT] "ok bug 2 doesn't really bother me but fix it and make sure counts update"

121. [2026-04-27/CompPortal.md|L6241|18:07:44 EDT] "so i'm doing spot checks seeing lots of wrong photos in end of routines; eg 193 timecode of video ends 1:10:13pm but exif 1:1024pm to 1:10:42 pm is in their routine, all from next routine"

122. [2026-04-27/CompPortal.md|L6314|18:12:12 EDT] "wait explain collision check"

123. [2026-04-27/CompPortal.md|L6328|18:13:10 EDT] "ok so for those just drop the specifi ones so dupes aren't created; we need the others moved"

124. [2026-04-27/CompPortal.md|L6671|18:17:46 EDT] "wait i thought the 443 were ruled fine? or they created duopes? as in they already exist in the proper routine and in erroed routines?"

125. [2026-04-27/CompPortal.md|L6703|18:21:43 EDT] "ok drop them from errored routines"

126. [2026-04-27/CompPortal.md|L6764|18:28:44 EDT] "new finding; GRAVITY 612 is embedded in 613s video, needs speration at 2:40 mark on all videos and backfill of timecode"

127. [2026-04-27/CompPortal.md|L6859|18:34:14 EDT] "we need the existing UPLAOD PHOTOS in ALL PHTOOS view to exist wahen NO PPHOTOS exist for routine so we can upload photos"

128. [2026-04-27/CompPortal.md|L7067|18:42:36 EDT] "i want to confirm users are seeing the EXPECTED TIME OF MEDIA DELIVERY on their family portals"

129. [2026-04-27/CompPortal.md|L7129|18:38:28 EDT] "we need to replace email for Studio III Dance Inc    info@studio3dance.net with Office.studio3dance@gmail.com"

130. [2026-04-27/CompPortal.md|L7161|18:44:25 EDT] "can we add an EDIT BUTTON in STUDIO INVIDE modal in cd media dash so they can click to edit it"

131. [2026-04-27/CompPortal.md|L7201|18:32:48 EDT] "ok existing 612 video is actually 608"

132. [2026-04-27/CompPortal.md|L7212|18:35:08 EDT] "maybe ignore 608 timestamps i'll just upload, just make sure nothing gets overwritten as we work"

133. [2026-04-27/CompPortal.md|L7305|18:46:24 EDT] "what is user kristenarruda03@gmail.com seeing"

134. [2026-04-27/CompPortal.md|L7605|19:36:37 EDT] "Why wouldn't cspraggett@gmail.com see media"

135. [2026-04-27/CompPortal.md|L7658|19:38:58 EDT] "Did the visibility toggles not set them all to published or something?"

136. [2026-04-27/CompPortal.md|L7673|19:40:24 EDT] "No, we want the toggles in the visibility settings on the competition filter to properly publish them and unpublish them complete means that they've been uploaded but are still pending. Review and published means they should be viewable in the portals and should be affected by the visibility toggle. Complete means that they've been uploaded but are still pending. Review and published means they should be viewable in the portals and should be affected by the visibility toggle."

137. [2026-04-27/CompPortal.md|L7790|23:28:26 EDT] "Confirming that the 146 slot shows video 156"

138. [2026-04-27/CompPortal.md|L7825|23:35:00 EDT] "and look into ontariodanceacademy@gmail.com"

139. [2026-04-27/CompPortal.md|L7867|23:37:59 EDT] "check vercel/supabase logs for login issues"

140. [2026-04-27/CompPortal.md|L7961|23:41:41 EDT] "what work did we do on 146? its the wrong videos"

141. [2026-04-28/CompPortal.md|L772|12:42:13 EDT] "Dig into our recent visibility edits to make sure we didn't break something"

142. [2026-04-28/CompPortal.md|L845|12:51:30 EDT] "Look into email bradforddance@yahoo.com recent this is the second complaint we've had about no audio on the critiques but it's playing back for me fine. AAC encoded what's going on?"

143. [2026-04-28/CompPortal.md|L1073|12:49:02 EDT] "Media arrives mid-show in the pending State. Once media is in it flips to completed but completed is still not visible to parents and SDS. Then the the visibility toggles on the competition filters on the cd-board can toggle their visibility to published and once published they become viewable in the portals. When media is unpublished. There's the user messages including the expected time which can be set in the same visibility. Modal we have been over this a thousand times and you have broken i..."

144. [2026-04-28/CompPortal.md|L1108|12:54:46 EDT] "What did you just change? All of the Toronto packages should be already published and visible to parents"

145. [2026-04-28/CompPortal.md|L1174|13:01:39 EDT] "You have. We haven't even confirmed that the silence exist cuz I'm telling you I'm listening to Bradford critiques on my phone and they sound fine"

146. [2026-04-28/CompPortal.md|L2014|14:26:28 EDT] "I know it doesn't exist in the UI but programmatically are we able to discreetly set certain routines visibility for judge videos versus others"

147. [2026-04-28/CompPortal.md|L2376|15:14:17 EDT] "Okay, this is the thread we were talking about. Disabling specific judge videos right?"

148. [2026-04-25/CompPortal.md|L1105|19:46:14 EDT] "Wait what did you do to venue TV"

149. [2026-04-25/CompPortal.md|L1119|20:24:21 EDT] "i dont need any public facing shcedules to show the added routine"

150. [2026-04-26/CompPortal.md|L777|12:24:13 EDT] "Ok now we need to work https://udc.compsync.net/livestream to update to add Toronto archive videos"

151. [2026-04-28/CompPortal.md|L1|23:50:58 EDT] "need SUNDAY TO LIVE REPLAY put on livaestream page 1186613803"

---

## C. R199 / Friday judge audio incident — operator findings

1. [2026-04-28/CompSyncElectronApp.md|L238|13:17:41 EDT] "check logs for r198-r203 we lost judge audio for some reason"

2. [2026-04-28/CompSyncElectronApp.md|L324|13:23:11 EDT] "but did the app fire its alerts?"

3. [2026-04-28/CompSyncElectronApp.md|L343|13:25:08 EDT] "but we DID have that implemented as i watched it fire Saturday AM when a mic was mistanekly turned off; we DO have low audio detection"

4. [2026-04-28/CompSyncElectronApp.md|L404|13:29:20 EDT] "that still doesn't explain WHY the channels went dead; and we have audio meteres that the oeprator would have noticed"

5. [2026-04-28/CompSyncElectronApp.md|L430|13:32:41 EDT] "No we have audio meters within the Electron app that our direct mirrors of the OBS meters that would have been flagging the operator would have seen them not metering"

6. [2026-04-28/CompSyncElectronApp.md|L490|13:38:24 EDT] "But even if that happened we would have seen zero audio metering on the audio meters in the Electron app because they're 1 to 1 mirrors of OBS"

7. [2026-04-28/CompSyncElectronApp.md|L596|13:50:38 EDT] "Keep probing Make an incident report And yes I think there should be occasional automated spot checks of audio for each routine so this can be flagged How would that work and how would that not consume too many resources during live production"

8. [2026-04-28/CompPortal.md|L1394|13:24:21 EDT] "ok you're getting ready to rebuild all judge videos for affected routines from backups; I have mic1-mic3 (j1-j3) wav files, The process will be use the performance audio to sync the start of the music then line up each judge's audio so the audio correctly lines up with the routine and then render out the three judge videos"

9. [2026-04-28/CompPortal.md|L1428|13:28:30 EDT] "ok its on shared as judgerescued"

10. [2026-04-28/CompPortal.md|L1478|13:31:39 EDT] "Soundpad is irrelevant it's only MIC12 and Three that we need i've listened to the audio myself and can confirm that it's all there We need to Identify all the breakpoints which is where you can exactly hear the announcer say the routine number and then we need to line them up to the performance videos"

11. [2026-04-28/CompPortal.md|L1487|13:33:49 EDT] "Yes but we need to work non destructively"

12. [2026-04-28/CompPortal.md|L1509|13:35:13 EDT] "I don't understand what you're asking and what we're trying to do I have confirmed that the full day's audio exists"

13. [2026-04-28/CompPortal.md|L1534|13:36:09 EDT] "That first file is a 48 minute file but the rest of the files are elsewhere in the folders but please note that they're all named mic 1 MIC 2 so you need to be careful about overwriting etcetera"

14. [2026-04-28/CompPortal.md|L1571|13:41:41 EDT] "\"D:\\Shared\\JudgeRescued\\2025_0424_1444\" folder starts at entry 200"

15. [2026-04-28/CompPortal.md|L1577|13:42:24 EDT] "it actually starts at mid-199 from that folder so we do miss the very beginnning of 199"

16. [2026-04-28/CompPortal.md|L1693|13:47:33 EDT] "yes, start keeping track of the workflow so it can recplicate; Just a note that we won't be able to simply do it by time code at any point because some routines get skipped etc so we actually need to run it by transcription based time code if that makes sense"

17. [2026-04-28/CompPortal.md|L1769|13:57:15 EDT] "200 is not aligned, beginnign is cut off and ends ~90s early, we hear entry 201 ~3:56 point which would be on the next video, note the actual dance doesn't begin until :24 in the perf video, how do we get these properly aliggned"

18. [2026-04-28/CompPortal.md|L1812|14:04:45 EDT] "I tell you this each routine is roughly 2 1/2 minutes long and I know at least judge one says some variant of thank you at the end of the routine as they're walking off the stage as well as applause I wonder if we could use the routine length as a rough in then listen for applause both of that in the performance video to determine the end of the routine then judge one thank you or thank you dancers as the end we also have ground truth that all of the mic 1 mic 2 mic 3 are the exact same length e..."

19. [2026-04-28/CompPortal.md|L1880|14:12:17 EDT] "No i meant perf wont have JUDGE voice"

20. [2026-04-28/CompPortal.md|L1914|14:20:44 EDT] "not aligned FYI judge audio compeltes ~4:12 but it should be 3:55; as in THANK YOU DANCERS is at 355 in latest video but it should land ~415. Are you using the giant spike in audio on the performance video where there's applause"

21. [2026-04-28/CompPortal.md|L1920|14:23:02 EDT] "If I were doing this in Davinci Resolve I would look at the giant spikes in audio at the end of each perf video and line them up to the judge video but that won't work blindly because routines might get skipped But we could use that to determine what judge audio we're lining up but for the sync and sub 2nd precision I think the audio peeking on applause is a better signal"

22. [2026-04-28/CompPortal.md|L1936|14:28:09 EDT] "What if we use silences in the judge videos and the applause peak in the performance videos to line up ends of routines. as in Use the applause peak from a performance video to Gage the end of a routine like the final pose We can find that same peak in the judge audio because immediately following that peak in the judge audio there will be stretches of silence"

23. [2026-04-28/CompPortal.md|L1970|14:24:27 EDT] "Did you actually just look because I just used the visibility controls to set the Judge's visibility to off"

24. [2026-04-28/CompPortal.md|L2033|14:34:59 EDT] "its still off, would need to be shifted BACK ~2s"

25. [2026-04-28/CompPortal.md|L2055|14:39:32 EDT] "I wonder if we use the same formula you just did manually hard code a 2.5 second back shift and do three more routines and let me check them"

26. [2026-04-28/CompPortal.md|L2065|14:42:02 EDT] "And to be absolutely clear in 200 the current version I needed the judge audio to be 2.5 seconds earlier"

27. [2026-04-28/CompPortal.md|L2300|15:04:29 EDT] "I'm listening to 202 Sing and can confirm that the silence doesn't occur because the recording is stopped before the applause cuts off but there is still an applause peak"

28. [2026-04-28/CompPortal.md|L2309|15:05:22 EDT] "203 judge audio starts in teh MIDDLE its not aligned"

29. [2026-04-28/CompPortal.md|L2336|15:08:23 EDT] "I just need the original performance videos for each of the affected routines downloaded to firmament one at a time"

30. [2026-04-28/CompPortal.md|L2480|15:27:08 EDT] "What I want to do is be able to have one single timeline with each performance video sequentially line up the judge audio for all the routines with a marker on the timeline of where each one goes and then have all render jobs as in 3x the number of routines for each of the judge videos to be added to the render queue with the audio setting of the specific track they're supposed to render out audio wiseIn the render settings, this is under audio output track timeline track and it'll be tracks 23..."

31. [2026-04-28/CompPortal.md|L2741|15:34:01 EDT] "this wil take too long i cant do this"

32. [2026-04-28/CompPortal.md|L2824|15:37:06 EDT] "You can give me a file that will put all the routines in the order that they were performed noting that 202 danced later with all the markers already in place ?"

---

## D. Cross-cutting / other

### Logs / observability / SSH replacement

1. [2026-04-24/CompSyncElectronApp.md|L1000|02:33:19 EDT] "Yes, and what remains? My expectation is that I have a detailed log at the machine portal online and you have a quick and easy way to read logs without having to SSH"

2. [2026-04-24/CompSyncElectronApp.md|L1039|02:36:31 EDT] "I thought we discussed having some sort of public API of the logs of the machine that you could read and analyze and I will be able to see events from in the portal so we could easily check in on the machine without constant SSH"

3. [2026-04-24/CompSyncElectronApp.md|L1095|02:39:10 EDT] "If it doesn't already exist then make sure you build it. My expectation is that there is an easy to read. Log for both you and me that has every single event every single error every single crash so we don't have to constantly SSH into the machine because that disrupts production..."

4. [2026-04-26/CompSyncElectronApp.md|L1763|20:31:59 EDT] "stop ssh you have post machien logs"

5. [2026-04-26/CompSyncElectronApp.md|L1767|20:32:14 EDT] "WE HAVE A LOG SERVER"

6. [2026-04-26/CompSyncElectronApp.md|L1800|20:32:56 EDT] "once you find the log source server you need to REMEMBER THAT IN THSI REPO and always check it instead of SSh"

### Data fixes / post-event remediation lifecycle

7. [2026-04-25/CompSyncElectronApp.md|L7513|20:33:39 EDT] "lets do this one first 314 and 315 lost on judge 1 audio to re-record; there's recordings attache dto emails in my inbox, i need judge 1 video audio replaced with those files; you can SSH them off dart, rebuild on spyballoon, and update r2"

8. [2026-04-25/CompSyncElectronApp.md|L8390|21:32:02 EDT] "this session will be for all TORONTO DATA ROUTINE/MEDIA FIXES; I'm going to paste a list adn i need you to check transripts for which ones have been fixed already"

9. [2026-04-25/CompSyncElectronApp.md|L8804|21:49:27 EDT] "136 main folder is a long empty clip of stage"

10. [2026-04-25/CompSyncElectronApp.md|L8832|21:56:03 EDT] "356 top level hands is correct"

11. [2026-04-25/CompSyncElectronApp.md|L8888|21:57:44 EDT] "and make sure we're gtrackign all thlese changes gettign proper timestamps for exif matching; as exif should still line up to these routines"

12. [2026-04-26/CompSyncElectronApp.md|L3769|23:03:45 EDT] "I need you to make sure that you accounted for UTC etc on your exif of all photo manual uploading and importing today"

13. [2026-04-26/CompSyncElectronApp.md|L3796|23:04:35 EDT] "And include in the incident report that there was the backlog of 1500 items at the end of the day, which I think ended up blocking video uploads"

14. [2026-04-26/CompSyncElectronApp.md|L4046|23:20:51 EDT] "So my expectation now is that all videos and photos for this competition are complete except for a handful of routines that were scratched but there should be no giant clusters with missing photos or videos"

15. [2026-04-26/CompSyncElectronApp.md|L4130|23:27:46 EDT] "And was r66 the routine of the day and according to scheduled data"

16. [2026-04-26/CompSyncElectronApp.md|L4161|23:30:20 EDT] "I don't think that was a camera bug. The camera would never do that. This was likely due to a manual import. I'd be curious to know what routines it spanned"

17. [2026-04-26/CompSyncElectronApp.md|L4262|23:40:24 EDT] "And maybe the incident report could grow into a a bigger Toronto post-mortem that could include all of the re-record drama and the plan fixes that we discussed to make it less error prone"

18. [2026-04-27/CompSyncElectronApp.md|L611|16:42:38 EDT] "i'll need to see a simple list of changes we're planning; what behaviour is now, what we're changing it to, and the risk involved"

19. [2026-04-27/CompSyncElectronApp.md|L621|17:32:05 EDT] "can review the weekend transcripts to make sure all frustrations are captured in these fixes"

20. [2026-04-28/CompPortal.md|L151|00:03:44 EDT] "I guess I'm still paranoid that we're going to end up with this much manual fixing after the next competition. It's way too much. I want to make sure we've covered everything"

### Storage / disk

21. [2026-04-25/CompSyncElectronApp.md|L1763|11:55:05 EDT] "Also, just a heads up and don't act yet, but we're going to need to move the Toronto competition off to the transfer drive as we only have 100 GB left"

22. [2026-04-26/CompSyncElectronApp.md|L3430|22:33:32 EDT] "Dart is now on battery so you need to monitor the upload"

23. [2026-04-26/CompSyncElectronApp.md|L3606|22:43:16 EDT] "Machine fell asleep but it's woken back up now. Can you make sure?"

24. [2026-04-26/CompSyncElectronApp.md|L4085|21:11:36 EDT] "PULL OFF DART NOW what you need so we can work when it goes offline"

---

## E. Behavior coaching (not product issues — for separate handling)

1. [2026-04-23/CompSyncElectronApp.md|L666|21:48:37 EDT] "Why would you make such a stupid and dangerous assumption?"

2. [2026-04-23/CompSyncElectronApp.md|L881|22:13:57 EDT] "Stop telling me that you're not going to code something. You don't get to decide that"

3. [2026-04-23/CompSyncElectronApp.md|L1079|22:37:34 EDT] "Just a note that you are never too close the app on dart you will be asked to make changes to the app and I expect them to be fully ready on dart but I will close it before you patch"

4. [2026-04-24/CompSyncElectronApp.md|L1660|11:43:41 EDT] "Are you hallucinating those settings?"

5. [2026-04-24/CompSyncElectronApp.md|L2233|13:13:55 EDT] "ok so from here we get everything BUILT and READY for restart on DART, YOU NEVER RESTART just me, but I want it staged/quick for when i'm ready"

6. [2026-04-24/CompSyncElectronApp.md|L2281|13:15:58 EDT] "wtf no you wait for me go then you do it DO NOT DO IT NOW"

7. [2026-04-24/CompSyncElectronApp.md|L2442|13:23:22 EDT] "APP IS STILL LIVE DO NOT SWAP, Starting coding 1,2,4,5"

8. [2026-04-24/CompSyncElectronApp.md|L2980|13:42:22 EDT] "YOU CANNOT TOUCH DDART"

9. [2026-04-24/CompSyncElectronApp.md|L3239|13:55:57 EDT] "I guess 'm concerd you dont understand the mission here and whats alread ybeen built"

10. [2026-04-24/CompSyncElectronApp.md|L4304|15:09:50 EDT] "WHAT NO"

11. [2026-04-24/CompSyncElectronApp.md|L4308|15:10:01 EDT] "YOU ARE SO STUPID LATELY"

12. [2026-04-24/CompSyncElectronApp.md|L4312|15:10:06 EDT] "USERS EVERYWHERE CMPLAINING"

13. [2026-04-24/CompSyncElectronApp.md|L4404|15:18:31 EDT] "NOT TETHER SD"

14. [2026-04-24/CompSyncElectronApp.md|L4406|15:18:31 EDT] "WE ARE NOT USING TETHER"

15. [2026-04-24/CompSyncElectronApp.md|L4420|15:19:23 EDT] "STOP ASSUMING AND FIND THE ACTUAL PROBLEM"

16. [2026-04-24/CompSyncElectronApp.md|L4761|15:43:00 EDT] "yes I will restart DONT CLOSE APP"

17. [2026-04-24/CompSyncElectronApp.md|L4839|15:47:37 EDT] "you are not a production ready model"

18. [2026-04-24/CompSyncElectronApp.md|L4843|15:47:50 EDT] "look at how many SORRY, my mistake, i assumed..."

19. [2026-04-24/CompSyncElectronApp.md|L4847|15:48:03 EDT] "you're not NOTINY anything"

20. [2026-04-24/CompSyncElectronApp.md|L4851|15:48:15 EDT] "So why lie"

21. [2026-04-24/CompSyncElectronApp.md|L5845|16:38:22 EDT] "STOP ASSUMING BUSNIESS LOGIC STOP STOP STOP"

22. [2026-04-24/CompSyncElectronApp.md|L6457|17:14:49 EDT] "WHAT IS THE PROBLEM WITHOUR SYSTEM IT SHOUDLN\"T BE THIS COMPLICATED"

23. [2026-04-24/CompSyncElectronApp.md|L6712|17:27:34 EDT] "You're wrong so consisnetly you're likely goign to be pulled off the project"

24. [2026-04-24/CompSyncElectronApp.md|L6772|17:31:21 EDT] "I ASKED YOU TO SEARCH MANUALLY"

25. [2026-04-24/CompSyncElectronApp.md|L6793|17:32:19 EDT] "so why did you say this Correction, third time now — I was wrong again."

26. [2026-04-24/CompSyncElectronApp.md|L6826|17:34:13 EDT] "Really really sick of your incompetence"

27. [2026-04-24/CompSyncElectronApp.md|L7544|18:40:44 EDT] "DO NOT COSE APP"

28. [2026-04-25/CompSyncElectronApp.md|L970|03:41:16 EDT] "Stop pitching affecting the London competition"

29. [2026-04-25/CompSyncElectronApp.md|L1919|13:02:47 EDT] "You need to do some research on the whole system you're asking a bunch of dumb questions. There's an android app cscontrol"

30. [2026-04-25/CompSyncElectronApp.md|L2150|13:26:07 EDT] "TABLET DISPLAY IS CSCONTROLLWR APK"

31. [2026-04-25/CompSyncElectronApp.md|L2184|13:30:31 EDT] "Disregard item 2 you're hallucinating"

32. [2026-04-25/CompSyncElectronApp.md|L9326|22:25:29 EDT] "What was our last change to the stream deck plug-in"

33. [2026-04-26/CompSyncElectronApp.md|L1577|18:09:39 EDT] "How on Earth did you read that was my intent? Are you joking"

34. [2026-04-26/CompSyncElectronApp.md|L1725|20:30:40 EDT] "WE\"RE NOT USING THAT WE\"VE BEEN IMPORTING WITH SD"

35. [2026-04-26/CompSyncElectronApp.md|L1846|20:34:29 EDT] "REMEMBER THE LOG SOURCE"

36. [2026-04-26/CompSyncElectronApp.md|L2038|20:54:26 EDT] "INCIDENT REPORT"

37. [2026-04-26/CompSyncElectronApp.md|L2273|21:10:37 EDT] "THE MACHINE WLIL GO OFFLINE IN 60 min"

38. [2026-04-26/CompSyncElectronApp.md|L2277|21:11:46 EDT] "WHAT ARE YOU THINKING SO LONG AOBUT"

39. [2026-04-26/CompSyncElectronApp.md|L2281|21:11:54 EDT] "answe rin short sentences, what are you doing"

40. [2026-04-26/CompPortal.md|L3962|20:37:14 EDT] "I HAVE LOST CONFIDENCE IN WHAT YOU HAVE ODNE NAD WHAT REMAINS FROM MY NOTES"

41. [2026-04-26/CompPortal.md|L3972|20:39:11 EDT] "CAN YOU KEEP A SIMPLE TO DO LIST OR NOT"

42. [2026-04-26/CompPortal.md|L3996|20:57:36 EDT] "NUMBERED LIST SO I CAN ACTUALLY REPSOND"

43. [2026-04-26/CompPortal.md|L4012|20:58:47 EDT] "WHICH IS DONE AND WHICH NEEDS WORK WAKE THE FUCK UP"

44. [2026-04-26/CompPortal.md|L4677|23:12:12 EDT] "I'm not surprised you screwed this up because you've been screwing up near constantly and everybody is unsubscribing from Claude code for this reason"

45. [2026-04-27/CompPortal.md|L3276|15:27:27 EDT] "EST PLS"

46. [2026-04-27/CompPortal.md|L3293|15:27:41 EDT] "I\"M SICK OF ASKIGN YOU FOR EST YOU'RE SUPPOSED TO REMEMBER"

47. [2026-04-27/CompPortal.md|L7265|18:41:43 EDT] "I ALREADY TOLD YOU"

48. [2026-04-28/CompSyncElectronApp.md|L1054|15:01:18 EDT] "I DONT CARE"

49. [2026-04-28/CompSyncElectronApp.md|L1088|15:02:36 EDT] "And now I've lost confidence in the plan that you're working from that it doesn't include a bunch of hallucinated features like this"

50. [2026-04-28/CompSyncElectronApp.md|L1098|15:03:31 EDT] "I would make a numbered list that I can confirm our hallucinated or real"

51. [2026-04-28/CompSyncElectronApp.md|L1134|15:40:48 EDT] "i cant use this list they're almost all moarked invented"

52. [2026-04-28/CompSyncElectronApp.md|L1148|15:41:53 EDT] "lets tart over with just the issues I flagged and we'll rebuild the list"

53. [2026-04-28/CompSyncElectronApp.md|L1160|15:44:03 EDT] "NO NO NO I want to throughout the entire plan I just want to start with a transcription of all of the issues that I had with both the app and the comp portal media sorting I want you to scan the transcripts from Thursday to today including this most recent judge audio failure and create a list of issues and we're going to turn that into a list of things to code"

54. [2026-04-28/CompPortal.md|L705|12:36:17 EDT] "You're hallucinating just give me the status on the bulk of her routines and why she would say her touch videos are unloading. All of them are loaded in an okay right?"

55. [2026-04-28/CompPortal.md|L2173|14:59:42 EDT] "WE WERE WORKING ON 200 AND I SAID NEXT 3 and THAT WOULD INCLUDE 202 NO?!"

56. [2026-04-28/CompPortal.md|L2315|15:06:11 EDT] "No you can't do this you're too **** to handle something like this RETARTED"

57. [2026-04-28/CompPortal.md|L2325|15:07:48 EDT] "You have wasted hours of my time and now I have to do it manually anyways"

58. [2026-04-28/CompPortal.md|L2366|15:13:17 EDT] "This is a massive amount of hours I need to put into this and you have wasted a whole bunch of my time"

59. [2026-04-28/CompPortal.md|L2804|15:36:13 EDT] "I DONT NEED REPORTING EVERY VIDEO"

60. [2026-04-28/CompPortal.md|L2836|15:38:14 EDT] "I\"M USING DAVINCI RESOLVE"
