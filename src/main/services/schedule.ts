import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import fs from 'fs'
import path from 'path'
import { Competition, Routine } from '../../shared/types'
import { logger } from '../logger'

interface CSVRow {
  tenant_id?: string
  competition_id?: string
  entry_id: string
  entry_number: string
  routine_title: string
  dancers: string
  studio_name: string
  studio_code: string
  category: string
  classification: string
  age_group: string
  size_category: string
  duration_minutes: string
  scheduled_day: string
  scheduled_time?: string
  position: string
}

function rowToRoutine(row: CSVRow, index: number): Routine {
  return {
    id: row.entry_id || `local-${index}`,
    entryNumber: row.entry_number || String(index + 1),
    routineTitle: row.routine_title || 'Untitled',
    dancers: row.dancers || '',
    studioName: row.studio_name || '',
    studioCode: row.studio_code || '',
    category: row.category || '',
    classification: row.classification || '',
    ageGroup: row.age_group || '',
    sizeCategory: row.size_category || '',
    durationMinutes: parseFloat(row.duration_minutes) || 3,
    scheduledDay: row.scheduled_day || '',
    scheduledTime: row.scheduled_time || undefined,
    position: parseInt(row.position) || index + 1,
    status: 'pending',
  }
}

export function parseCSV(filePath: string): Competition {
  logger.schedule.info(`Parsing CSV: ${filePath}`)

  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.schedule.error(`Failed to read CSV file: ${msg}`)
    throw new Error(`Cannot read file: ${msg}`)
  }

  const result = Papa.parse<CSVRow>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })

  if (result.errors.length > 0) {
    logger.schedule.warn('CSV parse warnings:', result.errors)
  }

  if (result.data.length === 0) {
    logger.schedule.warn('CSV file is empty or has no valid rows')
    throw new Error('CSV file contains no data rows')
  }

  const routines = result.data.map((row, i) => rowToRoutine(row, i))

  // Extract tenant_id and competition_id from first row if present
  const firstRow = result.data[0]
  const tenantId = firstRow?.tenant_id || ''
  const competitionId = firstRow?.competition_id || ''

  // Extract unique days
  const days = [...new Set(routines.map((r) => r.scheduledDay).filter(Boolean))]

  // Derive competition name from filename
  const name = path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, ' ')

  const competition: Competition = {
    tenantId,
    competitionId,
    name,
    routines: routines.sort((a, b) => a.position - b.position),
    days,
    source: 'csv',
    loadedAt: new Date().toISOString(),
  }

  logger.schedule.info(
    `Loaded ${routines.length} routines, ${days.length} days, tenant: ${tenantId || '(none)'}`,
  )
  return competition
}

export function parseXLSX(filePath: string): Competition {
  logger.schedule.info(`Parsing XLSX: ${filePath}`)

  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.readFile(filePath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.schedule.error(`Failed to read XLSX file: ${msg}`)
    throw new Error(`Cannot read file: ${msg}`)
  }
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]

  const rows = XLSX.utils.sheet_to_json<CSVRow>(sheet, {
    defval: '',
    raw: false,
  })

  // Normalize header names
  const normalizedRows = rows.map((row) => {
    const normalized: Record<string, string> = {}
    for (const [key, value] of Object.entries(row)) {
      normalized[key.trim().toLowerCase().replace(/\s+/g, '_')] = String(value)
    }
    return normalized as unknown as CSVRow
  })

  const routines = normalizedRows.map((row, i) => rowToRoutine(row, i))

  const firstRow = normalizedRows[0]
  const tenantId = firstRow?.tenant_id || ''
  const competitionId = firstRow?.competition_id || ''
  const days = [...new Set(routines.map((r) => r.scheduledDay).filter(Boolean))]
  const name = path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, ' ')

  const competition: Competition = {
    tenantId,
    competitionId,
    name,
    routines: routines.sort((a, b) => a.position - b.position),
    days,
    source: 'csv',
    loadedAt: new Date().toISOString(),
  }

  logger.schedule.info(`Loaded ${routines.length} routines from XLSX`)
  return competition
}

export function loadSchedule(filePath: string): Competition {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.csv') {
    return parseCSV(filePath)
  } else if (ext === '.xls' || ext === '.xlsx') {
    return parseXLSX(filePath)
  }
  throw new Error(`Unsupported file format: ${ext}`)
}

/** Resolved connection data — stored after share code resolution for use by upload service */
export interface ResolvedConnection {
  tenant: string
  competitionId: string
  apiBase: string
  name: string
  apiKey: string
}

let resolvedConnection: ResolvedConnection | null = null

/** Get the current resolved connection (from share code or null if offline/CSV) */
export function getResolvedConnection(): ResolvedConnection | null {
  return resolvedConnection
}

/** Clear resolved connection (e.g. when loading a new competition) */
export function clearResolvedConnection(): void {
  resolvedConnection = null
}

/** Resolve a share code to tenant + competition details */
export async function resolveShareCode(shareCode: string): Promise<ResolvedConnection> {
  const code = shareCode.trim().toUpperCase()
  logger.schedule.info(`Resolving share code: ${code}`)

  const response = await fetch(`https://www.compsync.net/api/plugin/resolve/${encodeURIComponent(code)}`)

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Share code resolution failed: ${response.status} ${text}`)
  }

  const data = await response.json()
  logger.schedule.info(`Share code resolved: ${data.name} (${data.tenant})`)

  // Store for use by upload service
  resolvedConnection = data
  return data
}

/** Load schedule via share code — resolves code then fetches schedule */
export async function loadFromShareCode(shareCode: string): Promise<Competition> {
  const resolved = await resolveShareCode(shareCode)

  logger.schedule.info(`Loading schedule from ${resolved.apiBase}/api/plugin/schedule/${resolved.competitionId}`)

  const response = await fetch(`${resolved.apiBase}/api/plugin/schedule/${resolved.competitionId}`, {
    headers: {
      Authorization: `Bearer ${resolved.apiKey}`,
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`API schedule load failed: ${response.status} ${text}`)
  }

  const data = await response.json()
  logger.schedule.info(`Loaded ${data.routines.length} routines from share code`)
  return data as Competition
}

/** Build a filename prefix from resolved connection + entry number */
export function buildFilePrefix(entryNumber: string): string {
  const conn = getResolvedConnection()
  if (conn) {
    const tag = conn.name.replace(/[\s]+/g, '_')
    return `${conn.tenant}_${tag}_${entryNumber}`
  }
  return entryNumber
}

/** Legacy: load from API with explicit credentials (kept for backwards compat) */
export async function loadFromAPI(competitionId: string): Promise<Competition> {
  // This is now a no-op since we removed tenant/apiKey from settings
  throw new Error('Direct API loading removed. Use a share code instead.')
}
