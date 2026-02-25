import { BrowserWindow } from 'electron'

/** Send a message to the renderer process via IPC */
export function sendToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data)
  }
}
