import log from 'electron-log'
import path from 'path'
import { app } from 'electron'

// Configure log file location
log.transports.file.resolvePathFn = () =>
  path.join(app.getPath('userData'), 'logs', 'main.log')
log.transports.file.maxSize = 10 * 1024 * 1024 // 10MB
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
