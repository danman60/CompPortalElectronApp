import React, { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'
import TransitionPreview from './TransitionPreview'
import { IPC_CHANNELS } from '../../shared/types'
import type { ClipSortParams, ExecuteSortParams } from '../../shared/types'
import '../styles/photo-sorter.css'

export default function PhotoSorter(): React.ReactElement {
  const photoSort = useStore((s) => s.photoSort)
  const setPhotoSortStatus = useStore((s) => s.setPhotoSortStatus)
  const setPhotoSortProgress = useStore((s) => s.setPhotoSortProgress)
  const setPhotoSortResult = useStore((s) => s.setPhotoSortResult)
  const setPhotoSortError = useStore((s) => s.setPhotoSortError)
  const resetPhotoSort = useStore((s) => s.resetPhotoSort)
  const setPhotoSorterOpen = useStore((s) => s.setPhotoSorterOpen)

  // Setup form state
  const [sourceDir, setSourceDir] = useState('')
  const [destDir, setDestDir] = useState('')
  const [startNum, setStartNum] = useState(1)
  const [expectedGroups, setExpectedGroups] = useState('')
  const [threshold, setThreshold] = useState(0.8)
  const [mode, setMode] = useState<'copy' | 'move'>('copy')

  // IPC listeners
  useEffect(() => {
    const unsub1 = window.api.on(IPC_CHANNELS.CLIP_PROGRESS, (data: unknown) => {
      const d = data as { phase: string; current: number; total: number }
      setPhotoSortProgress(d)
    })
    const unsub2 = window.api.on(IPC_CHANNELS.CLIP_MODEL_PROGRESS, (data: unknown) => {
      const d = data as { status: string; progress: number }
      setPhotoSortProgress({
        phase: `Downloading model: ${d.status}`,
        current: d.progress,
        total: 100,
      })
    })
    return () => {
      unsub1()
      unsub2()
    }
  }, [setPhotoSortProgress])

  async function handleBrowseSource(): Promise<void> {
    const dir = await window.api.settingsBrowseDir()
    if (dir) setSourceDir(dir)
  }

  async function handleBrowseDest(): Promise<void> {
    const dir = await window.api.settingsBrowseDir()
    if (dir) setDestDir(dir)
  }

  async function handleAnalyze(): Promise<void> {
    if (!sourceDir) return
    setPhotoSortStatus('analyzing')
    try {
      const params: ClipSortParams = {
        sampleRate: 5,
        threshold,
        expectedGroups: expectedGroups ? parseInt(expectedGroups, 10) : undefined,
      }
      const result = await window.api.clipAnalyzeFolder(sourceDir, params)
      if (result?.error) {
        setPhotoSortError(result.error)
      } else {
        setPhotoSortResult(result)
      }
    } catch (err) {
      setPhotoSortError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleExecute(): Promise<void> {
    if (!photoSort.result || !destDir) return
    setPhotoSortStatus('executing')
    try {
      const params: ExecuteSortParams = { destDir, startNum, mode }
      const result = await window.api.clipExecuteSort(photoSort.result, params)
      if (result?.error) {
        setPhotoSortError(result.error)
      } else {
        setPhotoSortStatus('done')
      }
    } catch (err) {
      setPhotoSortError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleCancel(): Promise<void> {
    await window.api.clipCancel()
    resetPhotoSort()
  }

  function handleClose(): void {
    resetPhotoSort()
    setPhotoSorterOpen(false)
  }

  const progressPct =
    photoSort.progress && photoSort.progress.total > 0
      ? Math.round((photoSort.progress.current / photoSort.progress.total) * 100)
      : 0

  return (
    <div className="photo-sorter-overlay" onClick={(e) => { if (e.target === e.currentTarget) handleClose() }}>
      <div className="photo-sorter">
        <div className="photo-sorter-header">
          <h2>Photo Sorter</h2>
          <button className="photo-sorter-close" onClick={handleClose}>×</button>
        </div>

        {/* Setup Screen */}
        {photoSort.status === 'idle' && (
          <div className="photo-sorter-setup">
            <div className="ps-field">
              <label>Source Folder</label>
              <div className="ps-browse-row">
                <input type="text" value={sourceDir} readOnly placeholder="Select folder..." />
                <button onClick={handleBrowseSource}>Browse</button>
              </div>
            </div>

            <div className="ps-field">
              <label>Destination Folder</label>
              <div className="ps-browse-row">
                <input type="text" value={destDir} readOnly placeholder="Select folder..." />
                <button onClick={handleBrowseDest}>Browse</button>
              </div>
            </div>

            <div className="ps-field-row">
              <div className="ps-field">
                <label>Starting Number</label>
                <input
                  type="number"
                  min={1}
                  value={startNum}
                  onChange={(e) => setStartNum(parseInt(e.target.value, 10) || 1)}
                />
              </div>
              <div className="ps-field">
                <label>Expected Groups (optional)</label>
                <input
                  type="number"
                  min={1}
                  value={expectedGroups}
                  onChange={(e) => setExpectedGroups(e.target.value)}
                  placeholder="Auto"
                />
              </div>
            </div>

            <div className="ps-field">
              <label>
                Sensitivity: {threshold.toFixed(2)}
              </label>
              <input
                type="range"
                className="sensitivity-slider"
                min={0.7}
                max={0.95}
                step={0.01}
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value))}
              />
              <div className="ps-slider-labels">
                <span>More splits</span>
                <span>Fewer splits</span>
              </div>
            </div>

            <div className="ps-field">
              <label>File Operation</label>
              <div className="ps-radio-row">
                <label className="ps-radio">
                  <input
                    type="radio"
                    checked={mode === 'copy'}
                    onChange={() => setMode('copy')}
                  />
                  Copy
                </label>
                <label className="ps-radio">
                  <input
                    type="radio"
                    checked={mode === 'move'}
                    onChange={() => setMode('move')}
                  />
                  Move
                </label>
              </div>
            </div>

            <button
              className="ps-action-btn"
              onClick={handleAnalyze}
              disabled={!sourceDir}
            >
              Analyze
            </button>
          </div>
        )}

        {/* Analyzing Screen */}
        {photoSort.status === 'analyzing' && (
          <div className="photo-sorter-progress">
            <div className="ps-phase">
              {photoSort.progress?.phase || 'Starting...'}
            </div>
            <div className="ps-progress-bar">
              <div
                className="ps-progress-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="ps-progress-label">
              {photoSort.progress
                ? `${photoSort.progress.current} / ${photoSort.progress.total}`
                : ''}
            </div>
            <button className="ps-cancel-btn" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        )}

        {/* Review Screen */}
        {photoSort.status === 'review' && photoSort.result && (
          <div className="photo-sorter-review">
            <div className="ps-summary">
              Found {photoSort.result.transitions.length + 1} groups in{' '}
              {photoSort.result.totalPhotos} photos ({photoSort.result.embeddingsComputed}{' '}
              embeddings computed)
            </div>

            <div className="ps-transition-list">
              {photoSort.result.transitions.map((tr, i) => (
                <TransitionPreview
                  key={i}
                  index={i + 1}
                  transition={tr}
                  totalTransitions={photoSort.result!.transitions.length}
                />
              ))}
            </div>

            {photoSort.result.transitions.length === 0 && (
              <div className="ps-no-transitions">
                No transitions detected — all photos appear to be from the same group.
              </div>
            )}

            <div className="ps-review-actions">
              <button className="ps-action-btn" onClick={handleExecute} disabled={!destDir}>
                Confirm &amp; Sort
              </button>
              <button className="ps-secondary-btn" onClick={resetPhotoSort}>
                Re-analyze
              </button>
            </div>
          </div>
        )}

        {/* Executing Screen */}
        {photoSort.status === 'executing' && (
          <div className="photo-sorter-progress">
            <div className="ps-phase">
              {photoSort.progress?.phase || 'Sorting files...'}
            </div>
            <div className="ps-progress-bar">
              <div
                className="ps-progress-fill"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="ps-progress-label">
              {photoSort.progress
                ? `${photoSort.progress.current} / ${photoSort.progress.total}`
                : ''}
            </div>
          </div>
        )}

        {/* Done Screen */}
        {photoSort.status === 'done' && (
          <div className="photo-sorter-done">
            <div className="ps-done-icon">&#10003;</div>
            <div className="ps-done-message">
              Photos sorted into {photoSort.result?.groups.length || 0} folders
            </div>
            <button className="ps-action-btn" onClick={handleClose}>
              Done
            </button>
          </div>
        )}

        {/* Error Screen */}
        {photoSort.status === 'error' && (
          <div className="photo-sorter-error">
            <div className="ps-error-message">{photoSort.error}</div>
            <button className="ps-action-btn" onClick={resetPhotoSort}>
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
