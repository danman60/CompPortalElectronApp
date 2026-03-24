import React from 'react'
import type { ClipSortTransition } from '../../shared/types'

interface TransitionPreviewProps {
  index: number
  transition: ClipSortTransition
  totalTransitions: number
}

function basename(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export default function TransitionPreview({
  index,
  transition,
  totalTransitions,
}: TransitionPreviewProps): React.ReactElement {
  return (
    <div className="transition-preview">
      <div className="transition-header">
        <span className="transition-label">
          Transition {index} of {totalTransitions}
        </span>
        <span className="transition-photo-index">Photo {transition.index}</span>
      </div>
      <div className="transition-files">
        <div className="transition-file before">
          <span className="transition-file-label">Before</span>
          <span className="transition-filename">{basename(transition.beforePath)}</span>
        </div>
        <span className="transition-arrow">→</span>
        <div className="transition-file after">
          <span className="transition-file-label">After</span>
          <span className="transition-filename">{basename(transition.afterPath)}</span>
        </div>
      </div>
      <div className="transition-meta">
        <span className="transition-similarity">
          Similarity: {transition.similarity.toFixed(3)}
        </span>
        <span className={`confidence-badge confidence-${transition.confidence}`}>
          {transition.confidence}
        </span>
      </div>
    </div>
  )
}
