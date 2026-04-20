import log from 'electron-log'
import path from 'path'
import { app } from 'electron'

// Configure log file location
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs', 'main.log')

// Long-retention debug config (2026-04-19): lost Saturday R483 re-record
// context because rotate-on-size overwrote main.old.log. Now each rotation
// archives to a timestamped file (main.archive-2026-04-19_20-15-00.log), so
// the chain of history survives restarts and multi-day show operations.
log.transports.file.maxSize = 100 * 1024 * 1024 // 100MB per segment (was 10MB)
log.transports.file.archiveLogFn = (file: { path: string }) => {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const dir = path.dirname(file.path)
  const base = path.basename(file.path, '.log')
  return path.join(dir, `${base}.archive-${ts}.log`)
}
log.transports.file.format = '{y}-{m}-{d} {h}:{i}:{s}.{ms} [{level}] [{scope}] {text}'

// Console only in development
log.transports.console.level = process.env.NODE_ENV === 'development' ? 'debug' : false

// Scoped loggers
export const logger = {
  app: log.scope('App'),
  obs: log.scope('OBS'),
  ffmpeg: log.scope('FFmpeg'),
  upload: log.scope('Upload'),
  schedule: log.scope('Schedule'),
  settings: log.scope('Settings'),
  ipc: log.scope('IPC'),
  photos: log.scope('Photos'),
}

export default log
