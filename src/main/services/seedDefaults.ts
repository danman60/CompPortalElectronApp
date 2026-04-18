import fs from 'fs'
import path from 'path'
import { app } from 'electron'

let seeded = false

export function seedUserDataFromBundle(): void {
  if (seeded) return
  seeded = true

  let userData: string
  try {
    userData = app.getPath('userData')
  } catch {
    return
  }

  const defaultsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'defaults')
    : path.join(__dirname, '..', '..', '..', 'resources', 'defaults')

  if (!fs.existsSync(defaultsDir)) return

  try {
    if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true })
  } catch {
    return
  }

  let entries: string[] = []
  try {
    entries = fs.readdirSync(defaultsDir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const target = path.join(userData, entry)
    if (fs.existsSync(target)) continue
    try {
      fs.copyFileSync(path.join(defaultsDir, entry), target)
    } catch {
      // Swallow: a missing default is better than blocking startup
    }
  }
}
