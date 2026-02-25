import React, { useCallback, useRef } from 'react'
import '../styles/draghandle.css'

export default function DragHandle(): React.ReactElement {
  const handleRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const leftPanel = document.querySelector('.left-panel') as HTMLElement
    if (!leftPanel) return

    const startX = e.clientX
    const startWidth = leftPanel.offsetWidth
    const handle = handleRef.current

    handle?.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    function onMouseMove(e: MouseEvent): void {
      const newWidth = startWidth + (e.clientX - startX)
      if (newWidth >= 280 && newWidth <= 600) {
        leftPanel.style.width = newWidth + 'px'
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
  }, [])

  return <div className="drag-handle" ref={handleRef} onMouseDown={onMouseDown} />
}
