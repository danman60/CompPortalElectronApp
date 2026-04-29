/**
 * Item 17 — Take-immutable persistence.
 *
 * A "take" is a single uninterrupted OBS recording session. It exists
 * independently of any routine slot; reassign-while-recording (A54) updates
 * `currentTargetRoutineId` without disturbing the underlying take.
 *
 * Persisted at <outputDir>/_active_take.json. Atomic writes (write to .tmp
 * then rename) so a power loss can't leave a half-written file. On app boot,
 * if the file exists, it indicates a crash mid-recording — the boot path
 * surfaces a "stale take" event to the renderer rather than auto-binding.
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import type { ActiveTake } from '../../shared/types'
import { logger } from '../logger'
import { getSettings } from './settings'

function getTakeFilePath(): string {
  const outputDir = getSettings().fileNaming?.outputDirectory
  // Falls back to userData when no outputDir configured — better to lose
  // the file in a less-visible spot than to leak it onto C:\ root.
  const baseDir = outputDir && outputDir.trim().length > 0
    ? outputDir
    : app.getPath('userData')
  return path.join(baseDir, '_active_take.json')
}

/** Generate a fresh take id. */
export function newTakeId(): string {
  return crypto.randomUUID()
}

/** Load the active take if one exists. Returns null when no take is active. */
export function readActiveTake(): ActiveTake | null {
  try {
    const filePath = getTakeFilePath()
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as ActiveTake
    if (!parsed.takeId || !parsed.startedAt) return null
    return parsed
  } catch (err) {
    logger.app.warn(`take: read failed: ${err instanceof Error ? err.message : err}`)
    return null
  }
}

/** Atomic write — temp file + rename so a crash mid-write can't half-truncate. */
export function writeActiveTake(take: ActiveTake): void {
  const filePath = getTakeFilePath()
  const tmpPath = `${filePath}.tmp`
  try {
    const dir = path.dirname(filePath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(tmpPath, JSON.stringify(take, null, 2), 'utf-8')
    fs.renameSync(tmpPath, filePath)
    logger.app.info(`take: wrote ${take.takeId} target=${take.currentTargetRoutineId ?? 'null'}`)
  } catch (err) {
    logger.app.warn(`take: write failed: ${err instanceof Error ? err.message : err}`)
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

/**
 * Patch fields on the active take (typically `currentTargetRoutineId`). Reads
 * the existing file, merges, atomically rewrites. No-op if no active take.
 */
export function patchActiveTake(patch: Partial<ActiveTake>): ActiveTake | null {
  const cur = readActiveTake()
  if (!cur) return null
  const next: ActiveTake = { ...cur, ...patch }
  writeActiveTake(next)
  return next
}

/** Clear the active take (called after successful finalize). */
export function clearActiveTake(): void {
  try {
    const filePath = getTakeFilePath()
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
      logger.app.info('take: cleared')
    }
  } catch (err) {
    logger.app.warn(`take: clear failed: ${err instanceof Error ? err.message : err}`)
  }
}
