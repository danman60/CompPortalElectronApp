import { BrowserWindow } from 'electron'

/**
 * Broadcast a message to EVERY renderer window. Overlay Mode spawns extra
 * BrowserWindows (panels) that need the same state updates as the main window,
 * so a single-window send would starve them. Main-window-only callers still
 * work because the main window is always in the returned list.
 */
export function sendToRenderer(channel: string, data: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, data)
    }
  }
}
