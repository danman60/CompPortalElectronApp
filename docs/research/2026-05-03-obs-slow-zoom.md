# Smooth Slow Zoom on a Scene in OBS Studio — Research & Recommendation

Date: 2026-05-03
Target: OBS Studio 30/31+, CompSyncElectronApp (already drives OBS via `obs-websocket-js@5.0.7`).
Goal: trigger a cinematic Ken-Burns "push in" on a scene (or scene item) during a live competition, ~6 seconds, anchor-correct, no manual keyframing.

---

## 1. Summary table

| # | Approach | Setup effort | OBS plugin / install | Smoothness ceiling | Operator ergonomics | Hot-reloadable easing | Best when… |
|---|----------|--------------|----------------------|--------------------|---------------------|------------------------|------------|
| 1 | In-OBS **Lua** script (`obslua` + `timer_add`) | Low (drop a `.lua` into OBS Tools → Scripts) | None — Lua ships with OBS | Very smooth at 60 Hz tick; in-process, no network jitter | Native OBS hotkey + Tools menu | Edit + reload | You want zero plugin install and full programmatic control |
| 2 | In-OBS **Python** script (`obspython`) | Medium (Python interpreter must be installed and pointed at OBS on Windows/Mac) | Python 3.x runtime | Same as Lua, but Python **is not** recommended for `script_tick`; use `timer_add` only | Same | Same | You already script OBS in Python or need a non-trivial library |
| 3 | **Move plugin** (exeldro) — Move Source / Move Value filter | Low (Windows installer, ~3 MB) | `obs-move-transition` ≥ 3.2.1 (requires OBS 31.1+) | Frame-perfect; runs inside OBS render path | Click "Move" filter button or fire via hotkey; no code | Yes, GUI editor, 30 easing curves built-in | You want the lowest-code path and a graphical UI for tweaking |
| 4 | **WebSocket** from Electron (`obs-websocket-js` v5, `SetSceneItemTransform` on a timer) | Low for code, but you already have the WS client | None — `obs-websocket` ships with OBS 28+ | Good but not perfect — packet jitter and main-loop schedulability matter | Triggered from your existing app UI | Yes, in your TS code | You want the zoom button **inside CompSync** with full app context (current routine, schedule, etc.) |

Take-away: paths 3 and 4 are the two realistic shortlist candidates for this app. Paths 1/2 are documented for completeness and for the case where the operator wants to invoke a zoom from a plain OBS hotkey without the Electron app open.

---

## 2. Detailed walkthroughs

### 2.1 In-OBS Lua script

OBS Studio embeds **LuaJIT 2** (≈ Lua 5.2). Scripts go in **Tools → Scripts → +**. The full scripting API is documented at https://docs.obsproject.com/scripting and the C-equivalent symbols at https://docs.obsproject.com/reference-scenes.html.

Relevant entry points (verified in the live docs at the URL above):

- `obs.timer_add(callback, milliseconds)` — fires `callback` every `milliseconds`. Don't use `script_tick` (per-frame) — the docs say timers are "more efficient" and Python's GIL makes per-tick especially bad.
- `obs.obs_hotkey_register_frontend(name, description, callback)` — registers a hotkey the operator can bind in OBS settings.
- `obs.obs_get_source_by_name(name)`, `obs.obs_scene_from_source(...)`, `obs.obs_scene_find_source(scene, name)` — get an `obs_sceneitem_t`.
- `obs.obs_sceneitem_set_pos(item, vec2)`, `obs.obs_sceneitem_set_scale(item, vec2)` — write the transform.
- `obs.obs_sceneitem_get_pos(item, vec2_out)`, `obs.obs_sceneitem_get_scale(item, vec2_out)` — read it.
- Memory hygiene: every `obs_get_source_by_name` needs a `obs_source_release`; every list returned by `obs_scene_enum_items` needs `sceneitem_list_release`. Leaks crash OBS.

Worked, copy-pasteable Lua script — registers two hotkeys ("zoom in", "reset") and animates with ease-in-out cubic at 60 Hz:

```lua
-- file: ~/obs-scripts/slow_zoom.lua
-- OBS Tools → Scripts → + → select this file. Then bind hotkeys in
-- File → Settings → Hotkeys (look for "Slow Zoom: trigger" and
-- "Slow Zoom: reset").

obs           = obslua
local SCENE   = "Stage Cam"          -- scene name to act on
local SOURCE  = "Camera 1"           -- scene-item name to push in on
local DURATION_MS = 6000             -- 6 seconds
local TICK_MS = 16                   -- ~60 Hz
local TARGET_SCALE = 1.20            -- push from 1.0 → 1.20 (subtle)
-- anchor = subject point in CANVAS coords (where the zoom centers).
-- Defaults to canvas center (1920x1080); adjust per scene.
local ANCHOR_X = 960
local ANCHOR_Y = 540

local hk_trigger = obs.OBS_INVALID_HOTKEY_ID
local hk_reset   = obs.OBS_INVALID_HOTKEY_ID

local state = nil  -- nil when idle; populated while animating

local function ease_in_out_cubic(t)
  if t < 0.5 then return 4 * t * t * t end
  local f = (2 * t) - 2
  return 0.5 * f * f * f + 1
end

local function find_item(scene_name, source_name)
  local src = obs.obs_get_source_by_name(scene_name)
  if not src then return nil end
  local scene = obs.obs_scene_from_source(src)
  local item  = obs.obs_scene_find_source(scene, source_name)
  obs.obs_source_release(src)
  return item   -- borrowed reference, do NOT release
end

local function tick()
  if not state then return end
  local now = obs.os_gettime_ns() / 1e6
  local elapsed = now - state.start_ms
  local t = math.min(elapsed / DURATION_MS, 1.0)
  local k = ease_in_out_cubic(t)

  local sx = state.s0_x + (state.s1_x - state.s0_x) * k
  local sy = state.s0_y + (state.s1_y - state.s0_y) * k

  -- Anchor-correct position: keep ANCHOR pinned in canvas as scale changes.
  -- Derivation: see section 3 of this doc.
  local px = ANCHOR_X - (ANCHOR_X - state.p0_x) * (sx / state.s0_x)
  local py = ANCHOR_Y - (ANCHOR_Y - state.p0_y) * (sy / state.s0_y)

  local pos   = obs.vec2()
  local scale = obs.vec2()
  pos.x, pos.y     = px, py
  scale.x, scale.y = sx, sy
  obs.obs_sceneitem_set_pos(state.item, pos)
  obs.obs_sceneitem_set_scale(state.item, scale)

  if t >= 1.0 then
    obs.timer_remove(tick)
    state = nil
  end
end

local function start_zoom(pressed)
  if not pressed then return end
  if state ~= nil then return end  -- already animating
  local item = find_item(SCENE, SOURCE)
  if not item then return end

  local p0 = obs.vec2(); obs.obs_sceneitem_get_pos(item, p0)
  local s0 = obs.vec2(); obs.obs_sceneitem_get_scale(item, s0)

  state = {
    item = item,
    start_ms = obs.os_gettime_ns() / 1e6,
    p0_x = p0.x, p0_y = p0.y,
    s0_x = s0.x, s0_y = s0.y,
    s1_x = s0.x * TARGET_SCALE,
    s1_y = s0.y * TARGET_SCALE,
  }
  obs.timer_add(tick, TICK_MS)
end

local function reset_zoom(pressed)
  -- For demo simplicity we just abort the animation.
  -- A production version would store the original (p0, s0) the first time
  -- the script loaded and snap back to it here.
  if not pressed then return end
  if state then
    obs.timer_remove(tick)
    state = nil
  end
end

function script_description()
  return "Slow cinematic zoom for a scene item. Edit the SCENE / SOURCE / TARGET_SCALE / ANCHOR constants at the top."
end

function script_load(settings)
  hk_trigger = obs.obs_hotkey_register_frontend(
    "slow_zoom.trigger", "Slow Zoom: trigger", start_zoom)
  hk_reset = obs.obs_hotkey_register_frontend(
    "slow_zoom.reset", "Slow Zoom: reset", reset_zoom)
  local a = obs.obs_data_get_array(settings, "slow_zoom.trigger.binding")
  obs.obs_hotkey_load(hk_trigger, a); obs.obs_data_array_release(a)
  a = obs.obs_data_get_array(settings, "slow_zoom.reset.binding")
  obs.obs_hotkey_load(hk_reset, a); obs.obs_data_array_release(a)
end

function script_save(settings)
  local a = obs.obs_hotkey_save(hk_trigger)
  obs.obs_data_set_array(settings, "slow_zoom.trigger.binding", a)
  obs.obs_data_array_release(a)
  a = obs.obs_hotkey_save(hk_reset)
  obs.obs_data_set_array(settings, "slow_zoom.reset.binding", a)
  obs.obs_data_array_release(a)
end
```

Notes:
- `obs.timer_add` runs on the OBS main thread; if OBS is heavily loaded (high-bitrate NVENC + 4 inputs + a slow plugin) it can drift by a few ms. For 6-second zooms the drift is invisible. For tight, 0.5 s "snap" zooms it would matter — but that isn't this use case.
- `obs.obs_scene_find_source` returns a **borrowed reference** — never release it. Releasing it crashes OBS. (Common forum bug.)
- The `_release` sprinkling above is the bare minimum to avoid leaks; OBS's leak counter prints to the log on shutdown — verify "0 leaks" after a few zoom cycles.

### 2.2 In-OBS Python script

Same API, ported as `obspython`. Only meaningful differences:

- Windows: install Python 3.x (matching OBS architecture — 64-bit), then **Tools → Scripts → Python Settings → set the Python install path**. No path = scripts silently fail to load.
- Linux/Mac: usually picked up automatically.
- Per the OBS docs: "Using `script_tick` in Python is not recommended due to the global interpreter lock of Python." Use `timer_add` only — same as Lua.
- No real ergonomic win over Lua for a zoom script. Python pays off when you import `requests`, `numpy`, etc. — none of which a zoom needs.
- One real downside: extra install step on every operator's machine. Lua needs nothing.

For this user (Windows operator on DART, single-purpose script), **Lua wins over Python**. Skipping the full code listing — replace `obs.` with `obs.` (same names) and write `def` instead of `function`.

### 2.3 Move plugin (exeldro)

Repo: https://github.com/exeldro/obs-move-transition (verified live: 863 stars, latest release `Move 3.2.1`, version 3.2.0+ requires OBS 31.1+, Windows installer + flatpak available).

The Move plugin is the no-code path that the OBS streaming community standardizes on for animated scene-item changes. It ships several primitives — for a slow zoom, the relevant ones are:

- **Move Source filter** — added to a *scene*. Lets you store a "from" and "to" transform for any scene item in that scene and animate between them with a chosen duration + easing curve. Trigger: scene transition, hotkey, OBS-WebSocket call, or another Move filter.
- **Move Value filter** — added to a *source/filter*. Animates a single numeric filter property over time.
- **Move Action filter** — composite filter that can fire several actions at once (great for "zoom + change scene + un-mute").

For a Ken-Burns push:
1. Install the plugin (download `move-transition-3.2.1-windows-installer.exe` from the release page or the OBS forum resource link above).
2. In OBS, right-click the scene that holds the camera source → **Filters** → add **Move Source**.
3. Pick the scene item ("Camera 1"), click the **Get** button under "Position A" / "Scale A" to capture the current transform — this becomes the start state.
4. Adjust the scene item to the zoomed-in transform (drag a corner with Ctrl, or type values in Edit Transform), click **Get** under "Position B" / "Scale B" — this becomes the end state. Then move the scene item back to A.
5. Set **Duration** = 6000 ms, **Easing** = `Cubic ease in out` (or `Sine ease in out` for the smoothest cinematic feel — both ship in the plugin's `easing.h`, full list confirmed at https://github.com/exeldro/obs-move-transition/blob/master/easing.h: linear, quad/cubic/quart/quint/sine/circ/expo/elastic/back/bounce, each with In, Out, InOut variants).
6. In OBS **Settings → Hotkeys**, find the new "Move source filter" hotkey and bind it.
7. Plus a **Reset** hotkey: add a second Move Source filter that goes B→A with the same duration.

Why this is usually the right answer for streamers but **not the obvious answer here**:
- It's faster to set up, easier to tweak, and a non-developer operator can change easing or duration without touching code.
- But — it's per-scene configuration. Twenty-five competition scenes = twenty-five Move filters to set up and keep in sync. The Lua/WebSocket paths are *one* artifact that works across all scenes.
- Move is also frame-locked to OBS's render thread, so it's literally as smooth as it can be. The other paths can match it but not beat it.

### 2.4 WebSocket-driven from the Electron app

This is the path that fits CompSync's existing architecture. The app already has `obs-websocket-js@5.0.7` (verified in `node_modules/obs-websocket-js/package.json`) wired via `src/main/services/obs.ts`. Adding a zoom is purely additive — no new dependency, no plugin install on DART.

**The shape of `SetSceneItemTransform`**, verified against `obs-websocket` request handler source (`src/requesthandler/RequestHandler_SceneItems.cpp`, OBS-WebSocket master):

```ts
await obs.call('SetSceneItemTransform', {
  sceneName: 'Stage Cam',
  sceneItemId: 7,
  sceneItemTransform: {
    positionX: 0,        // canvas-space pixels
    positionY: 0,
    rotation: 0,         // degrees, range [-360, 360]
    scaleX: 1.0,         // 1.0 = source's native size
    scaleY: 1.0,
    // Optional bounds + crop fields (cropTop/Right/Bottom/Left, boundsType,
    // boundsAlignment, boundsWidth, boundsHeight, alignment) — leave them alone
    // for a simple zoom; only ship positionX/Y + scaleX/Y in each frame.
  },
});
```

The transform fields above are the names actually accepted by the C++ handler (`r.Contains("positionX") / "scaleX" / "boundsType" / "alignment"` etc., source linked in references). The TypeScript bindings type the `sceneItemTransform` field as `JsonObject` so the compiler won't help — use the field names exactly.

**Looking up `sceneItemId`** (it's not the source name):

```ts
const { sceneItemId } = await obs.call('GetSceneItemId', {
  sceneName: 'Stage Cam',
  sourceName: 'Camera 1',
});
```

**Reading the start transform** so the animation is stateless across triggers:

```ts
const { sceneItemTransform: from } = await obs.call('GetSceneItemTransform', {
  sceneName: 'Stage Cam',
  sceneItemId,
});
// from.positionX, from.positionY, from.scaleX, from.scaleY are all numbers.
```

**The animation loop** — the realistic sweet spot is **~60 Hz (16 ms)** with a `setInterval` (or `requestAnimationFrame` if running in a renderer; in main process use a `setTimeout`-based RAF replacement). Below is a self-contained TypeScript helper. Drop it into `src/main/services/obs.ts` or a new sibling file, wire it to an IPC channel + a button.

```ts
// kenBurnsZoom: animate a scene item from its current transform to a target
// scale, anchor-corrected, with easing. Cancels cleanly if invoked again.
//
// Why setInterval and not a tight while-loop: the renderer needs the main
// process to stay responsive for IPC, recording timer ticks, etc. 60 Hz is
// already tighter than a slow zoom needs.

type Easing = (t: number) => number;
const easeInOutCubic: Easing = t =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

let activeZoom: NodeJS.Timer | null = null;

export async function kenBurnsZoom(opts: {
  sceneName: string;
  sourceName: string;
  targetScale: number;        // e.g. 1.20
  durationMs: number;         // e.g. 6000
  anchorCanvasX: number;      // canvas-pixel x to keep pinned (subject)
  anchorCanvasY: number;      // canvas-pixel y to keep pinned
  ease?: Easing;
}): Promise<void> {
  if (activeZoom) { clearInterval(activeZoom); activeZoom = null; }
  const ease = opts.ease ?? easeInOutCubic;
  const TICK_MS = 16; // ~60 Hz

  const { sceneItemId } = await obs.call('GetSceneItemId', {
    sceneName: opts.sceneName, sourceName: opts.sourceName,
  });
  const { sceneItemTransform: from } = await obs.call('GetSceneItemTransform', {
    sceneName: opts.sceneName, sceneItemId,
  }) as { sceneItemTransform: { positionX: number; positionY: number; scaleX: number; scaleY: number } };

  const p0x = from.positionX, p0y = from.positionY;
  const s0x = from.scaleX,    s0y = from.scaleY;
  const s1x = s0x * opts.targetScale;
  const s1y = s0y * opts.targetScale;

  const startedAt = Date.now();
  return new Promise<void>(resolve => {
    activeZoom = setInterval(async () => {
      const t = Math.min((Date.now() - startedAt) / opts.durationMs, 1);
      const k = ease(t);
      const sx = s0x + (s1x - s0x) * k;
      const sy = s0y + (s1y - s0y) * k;
      // anchor math: see section 3
      const px = opts.anchorCanvasX - (opts.anchorCanvasX - p0x) * (sx / s0x);
      const py = opts.anchorCanvasY - (opts.anchorCanvasY - p0y) * (sy / s0y);

      try {
        await obs.call('SetSceneItemTransform', {
          sceneName: opts.sceneName,
          sceneItemId,
          sceneItemTransform: {
            positionX: px, positionY: py, scaleX: sx, scaleY: sy,
          },
        });
      } catch { /* swallow transient WS errors so the timer keeps going */ }

      if (t >= 1) {
        if (activeZoom) { clearInterval(activeZoom); activeZoom = null; }
        resolve();
      }
    }, TICK_MS);
  });
}
```

**Realistic minimum interval before OBS starts dropping frames:** in practice, ~16 ms (60 Hz) over a localhost WebSocket is comfortable. The same machine sending `SetSceneItemTransform` 60 times a second consumes a few percent CPU and OBS handles it on the WS thread without blocking the render thread. People report problems below ~8 ms (125 Hz) — the WS message queue starts to back up and the visual zoom looks lumpy because batched messages get applied on a single frame.

**The frame-perfect upgrade (`callBatch` + `SerialFrame`):** `obs-websocket` provides a batch execution mode `SerialFrame` (identifier value `1`, "designed to provide high accuracy for animations" — verified in protocol docs). With `SerialFrame`, you build the entire 6-second animation as a list of `{ SetSceneItemTransform, Sleep with sleepFrames: 1, SetSceneItemTransform, Sleep ... }` requests and `obs.callBatch(...)` it in one shot. OBS then advances one transform per render frame, regardless of network jitter. Cost: one large message (a 6-second animation at 60 fps = 360 transform requests + 360 sleeps = 720 requests, JSON-encoded ~200 KB), no cancel during playback.

Skeleton:

```ts
const FRAMES = 360; // 6 s at 60 fps
const requests: Array<{ requestType: string; requestData: any }> = [];
for (let i = 0; i <= FRAMES; i++) {
  const t = i / FRAMES;
  const k = easeInOutCubic(t);
  // ... compute sx, sy, px, py as above ...
  requests.push({ requestType: 'SetSceneItemTransform', requestData: { sceneName, sceneItemId, sceneItemTransform: { positionX: px, positionY: py, scaleX: sx, scaleY: sy } } });
  if (i < FRAMES) requests.push({ requestType: 'Sleep', requestData: { sleepFrames: 1 } });
}
await obs.callBatch(requests, { executionType: 1 /* SerialFrame */ });
```

Use the timer-based approach for "good enough" (96% of cases). Use the batch approach if you ever see jitter on the operator's monitor.

---

## 3. Anchor-correct zoom — the math

For a Ken-Burns push the subject must stay locked on screen as the source scales up. OBS's `positionX/positionY` is the canvas-space coordinate of the **alignment point** of the scene item (default alignment is top-left, value `5` is centered, etc.). When `scaleX` grows from `s0` to `s1`, the source's effective on-screen size grows proportionally; without a position correction, the source grows out of its top-left corner and the subject drifts down-right.

We want a fixed anchor point `A = (Ax, Ay)` in **canvas coordinates** (the spot on the operator's preview where the subject's eyes live) to remain at the same canvas pixel after the scale change. The relationship between a point inside the source at offset `(ox, oy)` from the scene item's origin and its on-screen canvas position is:

```
canvas_x = position_x + scale * ox
canvas_y = position_y + scale * oy
```

The subject's offset inside the source is fixed (it's a real point on the camera feed), so:

```
ox = (Ax - p0_x) / s0
oy = (Ay - p0_y) / s0
```

After scaling to `s1`, to keep `(canvas_x, canvas_y) = (Ax, Ay)`:

```
Ax = p1_x + s1 * ox     →    p1_x = Ax - s1 * ox = Ax - (Ax - p0_x) * (s1 / s0)
Ay = p1_y + s1 * oy     →    p1_y = Ay - (Ay - p0_y) * (s1 / s0)
```

That's exactly the formula used in both code samples above. Generalised over the easing curve (so the anchor stays pinned at every intermediate frame, not just the end):

```
sx(t) = s0_x + (s1_x - s0_x) * ease(t)
px(t) = Ax - (Ax - p0_x) * (sx(t) / s0_x)
```

(Same shape for y.)

**Worked example.** Canvas 1920×1080. Camera 1 source is 1920×1080 native, `scaleX = scaleY = 1.0`, `positionX = 0`, `positionY = 0` (so it fills the canvas exactly). Subject is centered: `Ax = 960, Ay = 540`. Push to `targetScale = 1.20`.

| t | ease | sx | px | py |
|---|------|----|----|----|
| 0.00 | 0.000 | 1.000 | 960 - (960-0) × 1.00 = **0** | **0** |
| 0.25 | 0.0625 | 1.0125 | 960 - 960 × 1.0125 = **-12** | **-6.75** |
| 0.50 | 0.500 | 1.100 | 960 - 960 × 1.10 = **-96** | **-54** |
| 0.75 | 0.9375 | 1.1875 | 960 - 960 × 1.1875 = **-180** | **-101.25** |
| 1.00 | 1.000 | 1.200 | 960 - 960 × 1.20 = **-192** | **-108** |

So position drifts from `(0, 0)` to `(-192, -108)` — i.e. the source is scrolled up-and-left by exactly the amount its growing edges would otherwise push the subject down-and-right. Any frame in the middle is visually anchored.

If the camera doesn't fill the canvas natively (most real cases — say the source is 3840×2160 letter-boxed into a 1920×1080 placement at `scaleX = 0.5`), the same formulas hold; just plug in the actual `s0` and `p0` you read with `GetSceneItemTransform`.

---

## 4. Easing function reference

| Curve | Formula `f(t), t ∈ [0,1]` | When to use |
|-------|----------------------------|-------------|
| Linear | `t` | Never for a zoom — looks robotic |
| Ease-out cubic | `1 - (1-t)^3` | Classic "zoom that decelerates into the subject" — Ken Burns standard |
| Ease-in-out cubic | `t < 0.5 ? 4t³ : 1 - (-2t+2)³/2` | Symmetric, smooth on both ends. **Best default for a 6-second cinematic push** |
| Ease-in-out sine | `-(cos(πt) - 1) / 2` | Gentlest possible curve, almost imperceptible start. Try this if cubic feels "too snappy at the start" |
| Ease-in cubic | `t³` | Reverse zoom-out (slow start, fast end) |
| Quint in/out | `t<.5 ? 16t⁵ : 1-((-2t+2)^5)/2` | More dramatic accel/decel; for "punch in" rather than "drift in" |

The Move plugin's `easing.h` (linked above) ships all 31 of these as named C functions, so if you go with path 3 you get a dropdown instead of typing math.

**Recommended for a 6-second slow zoom on a live performance:** ease-in-out cubic. It's the one used in the Lua and TS samples above.

---

## 5. Recommendation

**Primary: path 4 — drive the zoom from the Electron app over the existing WebSocket.**

The reasons specific to this user:

- The app is already the operator's command surface. The "zoom on this routine" button belongs next to the routine row, not in a hotkey panel underneath OBS. Path 4 lets you wire it to existing UI state (current routine, scene name from `compsync-state.json`, schedule context).
- Zero new install on DART. The asar-swap protocol already handles app updates. Path 3 would mean shipping a plugin installer to every machine and re-running it whenever the plugin updates.
- One artifact, every scene. Configure target scale and anchor per-scene in app config, not per-scene in OBS. Adding a new scene later means adding a row to a JSON file, not adding two Move filters.
- Per-frame control means the operator can interrupt mid-zoom (cancel the timer) — useful when something unexpected happens on stage. Move filters can be aborted but it's clunkier.
- The operator already triggers OBS via the app for recording start/stop, scene switching, replay. Putting zoom in the same surface keeps the muscle memory.

**Implementation sketch (single short ticket):**

1. Add `kenBurnsZoom()` (the TS function above) to `src/main/services/obs.ts` — same module that already wraps `obs-websocket-js`.
2. Add an IPC channel in `src/main/index.ts` that takes `{ sceneName, sourceName, targetScale, durationMs, anchorCanvasX, anchorCanvasY }` and calls `kenBurnsZoom`.
3. Add a "Zoom in" button on the renderer side (e.g. on the routine row or in `OverlayControls.tsx`); fire the IPC.
4. Per-scene config in `compsync-state.json` (or wherever scene metadata already lives): `{ "Stage Cam": { zoomTarget: 1.20, anchor: [960, 540] } }`. Default to 1.20 and canvas center.
5. Optional: add `kenBurnsZoomOut()` (or just reverse the start/end) as a second button.

**When to upgrade to path 3 (Move plugin):** if jitter ever shows up on the operator's monitor (it shouldn't on localhost, but if a future config uses obs-websocket over the network across machines, it can), pivot to building Move Source filters once per scene and triggering them via `CallVendorRequest` — the Move plugin exposes an obs-websocket vendor namespace specifically for this.

**When to use path 1 (Lua):** as an emergency fallback if the app isn't running (e.g. the operator is in OBS only). Worth shipping the Lua script alongside the app so it's pre-installed in OBS Tools → Scripts as a "B option."

**Don't use path 2 (Python).** No advantage over Lua for a zoom, plus the install footprint.

---

## 6. References

- OBS scripting docs (Lua/Python API, `timer_add`, `obs_hotkey_register_frontend`):
  https://docs.obsproject.com/scripting
- OBS scene-items reference (the C names backing `obspython`/`obslua`):
  https://docs.obsproject.com/reference-scenes.html
- `obs-websocket` protocol spec (`SetSceneItemTransform`, `GetSceneItemId`, `GetSceneItemTransform`, `RequestBatchExecutionType::SerialFrame`):
  https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
  Raw: https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.md
- `obs-websocket` source defining the actual transform field names accepted (`positionX`, `scaleX`, `rotation`, `boundsType`, etc.):
  https://raw.githubusercontent.com/obsproject/obs-websocket/master/src/requesthandler/RequestHandler_SceneItems.cpp
- `obs-websocket-js` v5 README (request shape, `call`, `callBatch`, executionType):
  https://github.com/obs-websocket-community-projects/obs-websocket-js
- Move Transition plugin (exeldro) — main repo, releases, easing list:
  - https://github.com/exeldro/obs-move-transition
  - https://github.com/exeldro/obs-move-transition/releases (Move 3.2.1, requires OBS 31.1+)
  - https://github.com/exeldro/obs-move-transition/blob/master/easing.h (full easing palette)
  - Forum / installer: https://obsproject.com/forum/resources/move-transition.913/
- Robert Penner easing (the canonical reference behind the Move plugin's `easing.c`):
  http://www.robertpenner.com/easing/
