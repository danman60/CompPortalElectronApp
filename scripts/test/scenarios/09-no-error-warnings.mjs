/**
 * 09-no-error-warnings — sweep main.log for unexpected error/warn patterns.
 * Whitelist known-chronic warnings (chat-bridge timeouts, OneDrive sync,
 * wifi-display fallback). Any NEW [error] or [warn] line fails the scenario.
 */
export const name = 'No unexpected errors/warnings'
export const description = 'Greps last N log lines for unwhitelisted error/warn'

const WHITELIST_PATTERNS = [
  /Output directory appears to be inside a cloud sync folder/,
  /Chat bridge: channel status =/,
  /Chat bridge: reconnecting/,
  /control-room heartbeat failed: This operation was aborted/,
  /wifi display monitorIndex.*invalid/,
  /pickLongestMkv: uploading.*instead of current/,
  /resumeRecordedRoutines failed:/, // KNOWN — fixed in 86756c3 but old log lines remain
  /WiFi Display Server/,
  /Loaded N routines/,
]

export const name2 = 'no-error-warnings'
export const description2 = 'Whitelist-driven log audit'

export async function run(api) {
  const logs = (await api.logs(500)).body
  if (typeof logs !== 'string') return { ok: false, why: 'logs not string' }

  const lines = logs.split('\n')
  const violations = []
  for (const line of lines) {
    if (!/\[(error|warn)\]/i.test(line)) continue
    if (WHITELIST_PATTERNS.some((re) => re.test(line))) continue
    violations.push(line.trim().slice(0, 200))
  }
  if (violations.length > 0) {
    return { ok: false, why: `${violations.length} unwhitelisted warn/error lines: ${violations.slice(0, 3).join(' | ')}` }
  }
  return { ok: true }
}
