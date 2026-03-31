import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import {
  Routine,
  Competition,
  RoutineBoundary,
  RecoveryState,
  IPC_CHANNELS,
} from '../../shared/types'
import { sendToRenderer } from '../ipcUtil'
import { logger } from '../logger'
import * as stateService from './state'
import * as audioTranscription from './audioTranscription'
import * as photoService from './photos'
import { getSettings } from './settings'
import { buildFilePrefix } from './schedule'

// ── Types ───────────────────────────────────────────────────────

export interface RecoveryConfig {
  mkvPaths: string[]
  photoFolderPath?: string
  outputDir: string
}

export interface RecoveryProgress {
  phase: 'extracting-audio' | 'transcribing' | 'parsing' | 'splitting-video' | 'importing-photos' | 'organizing' | 'complete' | 'error'
  percent: number
  detail: string
  currentRoutine?: string
  routinesFound?: number
  routinesTotal?: number
}

// ── State ───────────────────────────────────────────────────────

let recoveryState: RecoveryState = {
  active: false,
  phase: 'idle',
  percent: 0,
  detail: '',
}

let cancelled = false

export function getRecoveryState(): RecoveryState {
  return { ...recoveryState }
}

export function cancelRecovery(): void {
  cancelled = true
  recoveryState = {
    ...recoveryState,
    active: false,
    phase: 'error',
    detail: 'Cancelled by user',
  }
  sendProgress()
}

function sendProgress(): void {
  sendToRenderer(IPC_CHANNELS.RECOVERY_PROGRESS, recoveryState)
}

function updateState(update: Partial<RecoveryState>): void {
  recoveryState = { ...recoveryState, ...update }
  sendProgress()
}

// ── FFmpeg path (same logic as audioTranscription) ──────────────

function getFFmpegPath(): string {
  const ext = process.platform === 'win32' ? '.exe' : ''
  const userDataCopy = path.join(app.getPath('userData'), `ffmpeg${ext}`)
  if (fs.existsSync(userDataCopy)) return userDataCopy

  const resourcePath = path.join(process.resourcesPath || '.', `ffmpeg${ext}`)
  if (fs.existsSync(resourcePath)) return resourcePath

  try {
    const ffmpegStatic = require('ffmpeg-static') as string
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic
  } catch {}

  return 'ffmpeg'
}

// ── Helpers ─────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '_').trim()
}

function buildRoutineDir(routine: Routine, outputDir: string): string {
  const entry = sanitize(routine.entryNumber)
  return path.join(outputDir, entry)
}

function buildOutputFileName(routine: Routine): string {
  const prefix = buildFilePrefix(routine.entryNumber)
  const title = sanitize(routine.routineTitle).replace(/\s+/g, '_')
  return `${prefix}_${title}`
}

// ── Video Splitting ─────────────────────────────────────────────

async function splitVideoByBoundary(
  mkvPath: string,
  boundary: RoutineBoundary,
  routine: Routine,
  outputDir: string,
  onProgress?: (detail: string) => void,
): Promise<string> {
  const ffmpeg = getFFmpegPath()
  const routineDir = buildRoutineDir(routine, outputDir)
  await fs.promises.mkdir(routineDir, { recursive: true })

  const ext = path.extname(mkvPath)
  const outFileName = `${buildOutputFileName(routine)}${ext}`
  const outPath = path.join(routineDir, outFileName)

  onProgress?.(`Splitting: ${routine.entryNumber} ${routine.routineTitle}`)

  return new Promise<string>((resolve, reject) => {
    const args = [
      '-i', mkvPath,
      '-ss', String(boundary.videoOffsetStartSec),
      '-to', String(boundary.videoOffsetEndSec),
      '-c', 'copy',
      '-map', '0',        // preserve ALL tracks (video + all audio)
      '-y',
      outPath,
    ]

    const proc = spawn(ffmpeg, args)
    let stderr = ''

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    proc.on('close', (code) => {
      if (code !== 0) {
        const msg = `ffmpeg split failed for ${routine.entryNumber} (exit ${code}): ${stderr.slice(-300)}`
        logger.app.error('[Recovery]', msg)
        reject(new Error(msg))
        return
      }

      if (!fs.existsSync(outPath)) {
        reject(new Error(`Split complete but output not found: ${outPath}`))
        return
      }

      logger.app.info(`[Recovery] Split routine ${routine.entryNumber}: ${outPath}`)
      resolve(outPath)
    })

    proc.on('error', reject)
  })
}

// ── Main Recovery Flow ──────────────────────────────────────────

export async function startRecovery(
  config: RecoveryConfig,
  competition: Competition,
): Promise<void> {
  cancelled = false

  // Validate inputs
  for (const mkvPath of config.mkvPaths) {
    if (!fs.existsSync(mkvPath)) {
      throw new Error(`MKV file not found: ${mkvPath}`)
    }
  }

  try {
    await fs.promises.mkdir(config.outputDir, { recursive: true })
    // Test writability
    const testFile = path.join(config.outputDir, '.recovery-test')
    await fs.promises.writeFile(testFile, 'test')
    await fs.promises.unlink(testFile)
  } catch (err) {
    throw new Error(`Output directory not writable: ${config.outputDir} - ${(err as Error).message}`)
  }

  const routines = competition.routines
  if (routines.length === 0) {
    throw new Error('No routines in competition schedule')
  }

  // Build trigger names from routine data
  const triggerNames = routines.map((r) =>
    `${r.routineTitle} ${r.dancers}`.trim(),
  )

  updateState({
    active: true,
    phase: 'extracting-audio',
    percent: 0,
    detail: 'Starting recovery...',
    mkvPaths: config.mkvPaths,
  })

  logger.app.info(`[Recovery] Starting recovery: ${config.mkvPaths.length} MKV files, ${routines.length} routines`)

  try {
    // Phase 1-3: Extract audio, transcribe (chunked), parse announcements
    // processFullDayRecording handles all three phases internally
    let lastPhase = ''
    const { boundaries, segments } = await audioTranscription.processFullDayRecording(
      config.mkvPaths,
      triggerNames,
      (detail: string) => {
        if (cancelled) return

        // Map progress messages to phases
        let phase: RecoveryState['phase'] = 'extracting-audio'
        let percent = 0

        if (detail.includes('Extracting audio')) {
          phase = 'extracting-audio'
          const pctMatch = detail.match(/(\d+)%/)
          percent = pctMatch ? Math.round(parseInt(pctMatch[1]) * 0.2) : 5 // 0-20%
        } else if (detail.includes('Transcrib') || detail.includes('Loading Whisper') || detail.includes('chunk')) {
          phase = 'transcribing'
          percent = 30 // 20-50%
        } else if (detail.includes('Processing complete')) {
          phase = 'parsing'
          percent = 50
        } else {
          phase = lastPhase as RecoveryState['phase'] || 'extracting-audio'
          percent = recoveryState.percent
        }

        lastPhase = phase
        updateState({ phase, percent, detail })
      },
    )

    if (cancelled) return

    logger.app.info(`[Recovery] Found ${boundaries.length} boundaries from ${segments.length} transcript segments`)

    updateState({
      phase: 'splitting',
      percent: 50,
      detail: `Found ${boundaries.length} routine boundaries, splitting video...`,
      boundaries,
    })

    // Phase 4: Match boundaries to routines and split video
    // For each MKV, boundaries reference offsets within that specific file
    // With single MKV (common case), all boundaries apply to it
    // With multiple MKVs, boundaries are already grouped by processFullDayRecording

    const matchedBoundaries = matchBoundariesToRoutines(boundaries, routines, triggerNames)

    let splitCount = 0
    const totalToSplit = matchedBoundaries.filter((b) => b.routineId).length

    for (const boundary of matchedBoundaries) {
      if (cancelled) return
      if (!boundary.routineId) continue

      const routine = routines.find((r) => r.id === boundary.routineId)
      if (!routine) continue

      // Determine which MKV file this boundary belongs to
      // For now, use first MKV (single file is the common recovery case)
      const mkvPath = config.mkvPaths[0]

      try {
        const outputPath = await splitVideoByBoundary(
          mkvPath,
          boundary,
          routine,
          config.outputDir,
          (detail) => updateState({ detail, currentRoutine: routine.entryNumber }),
        )

        const routineDir = path.dirname(outputPath)

        // Update routine state
        stateService.updateRoutineStatus(routine.id, 'recorded', {
          outputPath,
          outputDir: routineDir,
        })

        splitCount++
        const pct = 50 + Math.round((splitCount / totalToSplit) * 35) // 50-85%
        updateState({
          percent: pct,
          detail: `Split ${splitCount}/${totalToSplit}: ${routine.entryNumber}`,
          routinesFound: splitCount,
          routinesTotal: totalToSplit,
        })
      } catch (err) {
        logger.app.error(`[Recovery] Failed to split routine ${routine.entryNumber}:`, err)
        // Continue with next routine
      }
    }

    // Phase 5: Import photos if provided
    if (config.photoFolderPath && !cancelled) {
      updateState({
        phase: 'photos',
        percent: 85,
        detail: 'Importing photos from SD card...',
      })

      try {
        // Re-read routines after status updates
        const updatedComp = stateService.getCompetition()
        if (updatedComp) {
          await photoService.importPhotos(
            config.photoFolderPath,
            updatedComp.routines,
            config.outputDir,
          )
        }
      } catch (err) {
        logger.app.error('[Recovery] Photo import error:', err)
        updateState({
          detail: `Photo import failed: ${(err as Error).message} (video split completed successfully)`,
        })
      }
    }

    if (cancelled) return

    // Complete
    updateState({
      active: false,
      phase: 'complete',
      percent: 100,
      detail: `Recovery complete: ${splitCount} routines split from ${config.mkvPaths.length} MKV file(s)`,
      routinesFound: splitCount,
      routinesTotal: totalToSplit,
    })

    logger.app.info(`[Recovery] Complete: ${splitCount}/${totalToSplit} routines split`)

  } catch (err) {
    const msg = (err as Error).message || String(err)
    logger.app.error('[Recovery] Failed:', msg)
    updateState({
      active: false,
      phase: 'error',
      detail: `Recovery failed: ${msg}`,
      error: msg,
    })
    throw err
  }
}

// ── Match boundaries to routines ────────────────────────────────

function matchBoundariesToRoutines(
  boundaries: RoutineBoundary[],
  routines: Routine[],
  triggerNames: string[],
): RoutineBoundary[] {
  // Boundaries come back with names matching triggerNames.
  // triggerNames[i] corresponds to routines[i].
  // Map boundary.name back to the routine.

  return boundaries.map((b) => {
    const triggerIdx = triggerNames.indexOf(b.name)
    if (triggerIdx >= 0 && triggerIdx < routines.length) {
      return { ...b, routineId: routines[triggerIdx].id }
    }
    return b
  })
}
