-- CompSync Slow Zoom — OBS Lua script
--
-- Two hotkeys ("Slow Zoom In" / "Slow Zoom Out") animate a configured
-- source's scale by ±10% over 10s with ease-in-out cubic, anchored on the
-- source's currently-rendered center. Re-triggering during an animation
-- restarts smoothly from the current state.
--
-- Setup in OBS:
--   1. Tools -> Scripts -> + -> select this file
--   2. Set "Scene name" and "Source name" in the script properties pane
--   3. Settings -> Hotkeys -> bind "Slow Zoom In" and "Slow Zoom Out"

obs = obslua

-- ===== Configurable via script properties =====
local scene_name = ""
local source_name = ""
local duration_s = 10.0
local zoom_amount = 0.10  -- 0.10 = 10%
local fps = 60

-- ===== Internal state =====
local hotkey_in_id = obs.OBS_INVALID_HOTKEY_ID
local hotkey_out_id = obs.OBS_INVALID_HOTKEY_ID
local anim = nil

-- ===== Easing =====
local function ease_in_out_cubic(t)
  if t < 0.5 then
    return 4.0 * t * t * t
  else
    local f = 2.0 * t - 2.0
    return 0.5 * f * f * f + 1.0
  end
end

local function lerp(a, b, t)
  return a + (b - a) * t
end

-- ===== Bit-flag helpers (avoid bit lib dependency) =====
local function has_flag(value, flag)
  return math.floor(value / flag) % 2 == 1
end

-- Where 'pos' falls within the source rect, as fractions:
--   (0,0) = top-left, (0.5,0.5) = center, (1,1) = bottom-right
local function alignment_offset(align)
  local ox, oy = 0.5, 0.5
  if has_flag(align, 1) then ox = 0.0       -- OBS_ALIGN_LEFT
  elseif has_flag(align, 2) then ox = 1.0   -- OBS_ALIGN_RIGHT
  end
  if has_flag(align, 4) then oy = 0.0       -- OBS_ALIGN_TOP
  elseif has_flag(align, 8) then oy = 1.0   -- OBS_ALIGN_BOTTOM
  end
  return ox, oy
end

-- ===== Scene/source lookup =====
local function find_sceneitem()
  if scene_name == "" or source_name == "" then return nil end
  local scene_source = obs.obs_get_source_by_name(scene_name)
  if scene_source == nil then return nil end
  local scene = obs.obs_scene_from_source(scene_source)
  obs.obs_source_release(scene_source)
  if scene == nil then return nil end
  return obs.obs_scene_find_source_recursive(scene, source_name)
end

-- ===== Animation =====
local function start_zoom(direction)
  -- direction: +1 for zoom-in, -1 for zoom-out (relative to current state)
  local item = find_sceneitem()
  if item == nil then return end

  local pos = obs.vec2()
  obs.obs_sceneitem_get_pos(item, pos)
  local scale = obs.vec2()
  obs.obs_sceneitem_get_scale(item, scale)

  local source = obs.obs_sceneitem_get_source(item)
  local sw = obs.obs_source_get_width(source)
  local sh = obs.obs_source_get_height(source)
  if sw == 0 or sh == 0 then return end

  local align = obs.obs_sceneitem_get_alignment(item)
  local ox, oy = alignment_offset(align)

  -- Center of the rendered rect in canvas space (handles any alignment)
  local cx = pos.x + (0.5 - ox) * sw * scale.x
  local cy = pos.y + (0.5 - oy) * sh * scale.y

  local factor = 1.0 + (direction * zoom_amount)
  anim = {
    item = item,
    t0 = obs.os_gettime_ns() / 1e9,
    dur = duration_s,
    sx0 = scale.x,
    sy0 = scale.y,
    sx1 = scale.x * factor,
    sy1 = scale.y * factor,
    cx = cx,
    cy = cy,
    sw = sw,
    sh = sh,
    ox = ox,
    oy = oy,
  }
end

local function tick()
  if anim == nil then return end

  local now = obs.os_gettime_ns() / 1e9
  local t = (now - anim.t0) / anim.dur
  if t > 1.0 then t = 1.0 end
  local et = ease_in_out_cubic(t)

  local sx = lerp(anim.sx0, anim.sx1, et)
  local sy = lerp(anim.sy0, anim.sy1, et)

  -- Solve pos so that the rendered center stays at (anim.cx, anim.cy)
  local new_pos = obs.vec2()
  new_pos.x = anim.cx - (0.5 - anim.ox) * anim.sw * sx
  new_pos.y = anim.cy - (0.5 - anim.oy) * anim.sh * sy

  local new_scale = obs.vec2()
  new_scale.x = sx
  new_scale.y = sy

  obs.obs_sceneitem_set_pos(anim.item, new_pos)
  obs.obs_sceneitem_set_scale(anim.item, new_scale)

  if t >= 1.0 then
    anim = nil
  end
end

-- ===== Hotkey callbacks =====
local function hotkey_in_cb(pressed)
  if pressed then start_zoom(1) end
end

local function hotkey_out_cb(pressed)
  if pressed then start_zoom(-1) end
end

-- ===== Script lifecycle =====
function script_description()
  return "<b>CompSync Slow Zoom</b><br/>"
      .. "Animates a source's scale by ±10% over 10s with ease-in-out, anchored on its rendered center.<br/>"
      .. "Bind hotkeys in Settings → Hotkeys: <i>Slow Zoom In</i> / <i>Slow Zoom Out</i>."
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_text(props, "scene_name", "Scene name", obs.OBS_TEXT_DEFAULT)
  obs.obs_properties_add_text(props, "source_name", "Source name", obs.OBS_TEXT_DEFAULT)
  obs.obs_properties_add_float_slider(props, "duration_s", "Duration (s)", 0.5, 30.0, 0.5)
  obs.obs_properties_add_float_slider(props, "zoom_amount", "Zoom amount (0.10 = 10%)", 0.01, 1.0, 0.01)
  return props
end

function script_defaults(settings)
  obs.obs_data_set_default_string(settings, "scene_name", "")
  obs.obs_data_set_default_string(settings, "source_name", "")
  obs.obs_data_set_default_double(settings, "duration_s", 10.0)
  obs.obs_data_set_default_double(settings, "zoom_amount", 0.10)
end

function script_update(settings)
  scene_name = obs.obs_data_get_string(settings, "scene_name")
  source_name = obs.obs_data_get_string(settings, "source_name")
  duration_s = obs.obs_data_get_double(settings, "duration_s")
  zoom_amount = obs.obs_data_get_double(settings, "zoom_amount")
end

function script_load(settings)
  hotkey_in_id = obs.obs_hotkey_register_frontend(
    "compsync_slow_zoom_in",
    "Slow Zoom In",
    hotkey_in_cb)
  local arr_in = obs.obs_data_get_array(settings, "compsync_slow_zoom_in_hk")
  obs.obs_hotkey_load(hotkey_in_id, arr_in)
  obs.obs_data_array_release(arr_in)

  hotkey_out_id = obs.obs_hotkey_register_frontend(
    "compsync_slow_zoom_out",
    "Slow Zoom Out",
    hotkey_out_cb)
  local arr_out = obs.obs_data_get_array(settings, "compsync_slow_zoom_out_hk")
  obs.obs_hotkey_load(hotkey_out_id, arr_out)
  obs.obs_data_array_release(arr_out)

  obs.timer_add(tick, math.floor(1000 / fps))
end

function script_save(settings)
  local arr_in = obs.obs_hotkey_save(hotkey_in_id)
  obs.obs_data_set_array(settings, "compsync_slow_zoom_in_hk", arr_in)
  obs.obs_data_array_release(arr_in)

  local arr_out = obs.obs_hotkey_save(hotkey_out_id)
  obs.obs_data_set_array(settings, "compsync_slow_zoom_out_hk", arr_out)
  obs.obs_data_array_release(arr_out)
end

function script_unload()
  obs.timer_remove(tick)
end
