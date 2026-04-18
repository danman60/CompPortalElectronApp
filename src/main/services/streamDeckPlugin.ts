import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { logger } from '../logger'

const PLUGIN_UUID = 'com.compsync.streamdeck.sdPlugin'

function getBundledPluginDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'streamdeck-plugin')
    : path.join(__dirname, '..', '..', '..', 'streamdeck-plugin', PLUGIN_UUID)
}

function getStreamDeckPluginsDir(): string | null {
  if (process.platform !== 'win32') return null
  const appdata = process.env.APPDATA
  if (!appdata) return null
  return path.join(appdata, 'Elgato', 'StreamDeck', 'Plugins')
}

function getTargetPluginDir(): string | null {
  const root = getStreamDeckPluginsDir()
  if (!root) return null
  return path.join(root, PLUGIN_UUID)
}

async function copyDirRecursive(src: string, dest: string): Promise<number> {
  let copied = 0
  const entries = await fs.promises.readdir(src, { withFileTypes: true })
  await fs.promises.mkdir(dest, { recursive: true })
  for (const entry of entries) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copied += await copyDirRecursive(s, d)
    } else if (entry.isFile()) {
      await fs.promises.copyFile(s, d)
      copied++
    }
  }
  return copied
}

export interface StreamDeckStatus {
  streamDeckInstalled: boolean
  pluginsDir: string | null
  pluginInstalled: boolean
  bundledAvailable: boolean
  bundledPluginJsMtime: string | null
  installedPluginJsMtime: string | null
}

export function getStatus(): StreamDeckStatus {
  const pluginsDir = getStreamDeckPluginsDir()
  const streamDeckInstalled = !!pluginsDir && fs.existsSync(pluginsDir)
  const targetDir = getTargetPluginDir()
  const pluginInstalled = !!targetDir && fs.existsSync(path.join(targetDir, 'bin', 'plugin.js'))

  const bundledDir = getBundledPluginDir()
  const bundledJs = path.join(bundledDir, 'bin', 'plugin.js')
  const bundledAvailable = fs.existsSync(bundledJs)

  let bundledPluginJsMtime: string | null = null
  let installedPluginJsMtime: string | null = null
  try {
    if (bundledAvailable) bundledPluginJsMtime = fs.statSync(bundledJs).mtime.toISOString()
  } catch {}
  try {
    if (pluginInstalled && targetDir) {
      installedPluginJsMtime = fs.statSync(path.join(targetDir, 'bin', 'plugin.js')).mtime.toISOString()
    }
  } catch {}

  return {
    streamDeckInstalled,
    pluginsDir,
    pluginInstalled,
    bundledAvailable,
    bundledPluginJsMtime,
    installedPluginJsMtime,
  }
}

export async function installPlugin(): Promise<{ ok: true; filesCopied: number; target: string } | { error: string }> {
  const bundledDir = getBundledPluginDir()
  if (!fs.existsSync(bundledDir)) return { error: 'Bundled plugin missing from this build' }

  const targetDir = getTargetPluginDir()
  if (!targetDir) return { error: 'Stream Deck plugins folder not available on this OS' }
  const pluginsRoot = getStreamDeckPluginsDir()
  if (!pluginsRoot || !fs.existsSync(pluginsRoot)) {
    return { error: 'Stream Deck is not installed (Plugins folder not found)' }
  }

  try {
    const filesCopied = await copyDirRecursive(bundledDir, targetDir)
    logger.app.info(`Stream Deck plugin installed: ${filesCopied} files -> ${targetDir}`)
    return { ok: true, filesCopied, target: targetDir }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.app.error(`Stream Deck plugin install failed: ${msg}`)
    return { error: msg }
  }
}
