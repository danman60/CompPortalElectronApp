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
    position: parseInt(row.position) || index + 1,
    status: 'pending',
  }
}

export function parseCSV(filePath: string): Competition {
  logger.schedule.info(`Parsing CSV: ${filePath}`)
  const content = fs.readFileSync(filePath, 'utf-8')

  const result = Papa.parse<CSVRow>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })

  if (result.errors.length > 0) {
    logger.schedule.warn('CSV parse warnings:', result.errors)
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
  const workbook = XLSX.readFile(filePath)
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
