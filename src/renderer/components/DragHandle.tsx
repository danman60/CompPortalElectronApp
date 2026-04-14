import React, { useCallback, useRef } from 'react'
import '../styles/draghandle.css'

interface DragHandleProps {
  target: string
  min: number
  max: number
  direction?: 'horizontal' | 'vertical'
}

export default function DragHandle({ target, min, max, direction = 'horizontal' }: DragHandleProps): React.ReactElement {
  const handleRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const panel = document.querySelector(target) as HTMLElement
    if (!panel) return

    const isVertical = direction === 'vertical'
    const startPos = isVertical ? e.clientY : e.clientX
    const startSize = isVertical ? panel.offsetHeight : panel.offsetWidth
    const handle = handleRef.current

    handle?.classList.add('dragging')
    document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize'
    document.body.style.userSelect = 'none'

    function onMouseMove(e: MouseEvent): void {
      const delta = (isVertical ? e.clientY : e.clientX) - startPos
      const newSize = startSize + delta
      if (newSize >= min && newSize <= max) {
        if (isVertical) {
          panel.style.height = newSize + 'px'
          panel.style.flex = 'none'
        } else {
          panel.style.width = newSize + 'px'
        }
      }
    }

    function onMouseUp(): void {
      handle?.classList.remove('dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [target, min, max, direction])

  return (
    <div
      className={`drag-handle ${direction === 'vertical' ? 'drag-handle-vertical' : ''}`}
      ref={handleRef}
      onMouseDown={onMouseDown}
    />
  )
}
