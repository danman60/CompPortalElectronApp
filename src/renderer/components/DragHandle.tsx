import React, { useCallback, useRef } from 'react'
import '../styles/draghandle.css'

interface DragHandleProps {
  target: string
  min: number
  max: number
}

export default function DragHandle({ target, min, max }: DragHandleProps): React.ReactElement {
  const handleRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const panel = document.querySelector(target) as HTMLElement
    if (!panel) return

    const startX = e.clientX
    const startWidth = panel.offsetWidth
    const handle = handleRef.current

    handle?.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function onMouseMove(e: MouseEvent): void {
      const newWidth = startWidth + (e.clientX - startX)
      if (newWidth >= min && newWidth <= max) {
        panel.style.width = newWidth + 'px'
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
  }, [target, min, max])

  return <div className="drag-handle" ref={handleRef} onMouseDown={onMouseDown} />
}
