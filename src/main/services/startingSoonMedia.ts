import express from 'express'
import path from 'path'
import fs from 'fs'
import { logger } from '../logger'

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov']
const PHOTO_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
const SPONSOR_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg']

let videoFolder = ''
let photoFolder = ''
let sponsorFolder = ''

export function setVideoFolder(folderPath: string): void {
  videoFolder = folderPath
  logger.app.info(`SS media: video folder set to ${folderPath}`)
}

export function setPhotoFolder(folderPath: string): void {
  photoFolder = folderPath
  logger.app.info(`SS media: photo folder set to ${folderPath}`)
}

export function setSponsorFolder(folderPath: string): void {
  sponsorFolder = folderPath
  logger.app.info(`SS media: sponsor folder set to ${folderPath}`)
}

export function scanFolder(folderPath: string, type: 'video' | 'photo' | 'sponsor'): string[] {
  if (!folderPath || !fs.existsSync(folderPath)) return []
  try {
    const exts = type === 'video' ? VIDEO_EXTENSIONS : type === 'sponsor' ? SPONSOR_EXTENSIONS : PHOTO_EXTENSIONS
    return fs.readdirSync(folderPath)
      .filter(f => exts.some(ext => f.toLowerCase().endsWith(ext)))
      .sort()
  } catch {
    return []
  }
}

export function setupMediaRoutes(app: express.Application): void {
  // Serve video files with range request support
  app.get('/media/videos/:filename', (req, res) => {
    if (!videoFolder) { res.status(404).send('No video folder configured'); return }
    const filePath = path.join(videoFolder, path.basename(req.params.filename))
    if (!fs.existsSync(filePath)) { res.status(404).send('File not found'); return }
    res.sendFile(filePath, { acceptRanges: true })
  })

  // Serve photo files
  app.get('/media/photos/:filename', (req, res) => {
    if (!photoFolder) { res.status(404).send('No photo folder configured'); return }
    const filePath = path.join(photoFolder, path.basename(req.params.filename))
    if (!fs.existsSync(filePath)) { res.status(404).send('File not found'); return }
    res.sendFile(filePath)
  })

  // List video files
  app.get('/media/list/videos', (_req, res) => {
    res.json(scanFolder(videoFolder, 'video'))
  })

  // List photo files
  app.get('/media/list/photos', (_req, res) => {
    res.json(scanFolder(photoFolder, 'photo'))
  })

  // Serve sponsor logo files
  app.get('/media/sponsors/:filename', (req, res) => {
    if (!sponsorFolder) { res.status(404).send('No sponsor folder configured'); return }
    const filePath = path.join(sponsorFolder, path.basename(req.params.filename))
    if (!fs.existsSync(filePath)) { res.status(404).send('File not found'); return }
    res.sendFile(filePath)
  })

  // List sponsor logo files
  app.get('/media/list/sponsors', (_req, res) => {
    res.json(scanFolder(sponsorFolder, 'sponsor'))
  })

  logger.app.info('SS media routes registered')
}
