import { useEffect, useRef, useState } from 'react'
import { MenuSeparator, MenuSubmenu } from '../menu/types'
import type { MenuItem } from '../menu/types'

interface ContextMenuProps {
  items: MenuItem[]
  x: number
  y: number
  onClose: () => void
}

interface OpenSubmenu {
  index: number
  submenu: MenuSubmenu
  x: number
  y: number
}

function menuItemClass(item: MenuItem, index: number, openIndex: number | null): string {
  let cls = 'menu__item'
  if (item instanceof MenuSeparator) return cls
  if (openIndex === index) cls += ' menu__item--open'
  return cls
}

function SeparatorRow() {
  return <div className="menu__separator" />
}

export function ContextMenu({ items, x, y, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [submenu, setSubmenu] = useState<OpenSubmenu | null>(null)
  const [pos, setPos] = useState({ x, y })

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const overflowX = rect.right > window.innerWidth ? rect.width : 0
    const overflowY = rect.bottom > window.innerHeight ? rect.height : 0
    setPos({ x: Math.max(0, x - overflowX), y: Math.max(0, y - overflowY) })
  }, [x, y])

  const closeSubmenu = () => setSubmenu(null)

  return (
    <>
      <div
        ref={ref}
        className="menu"
        style={{ left: pos.x, top: pos.y }}
        onClick={onClose}
        onMouseLeave={closeSubmenu}
      >
        {items.map((item, i) => {
          if (item instanceof MenuSeparator) return <SeparatorRow key={i} />
          const isSubmenu = item instanceof MenuSubmenu
          return (
            <div
              key={i}
              className={menuItemClass(item, i, submenu?.index ?? null)}
              onClick={(e) => {
                if (isSubmenu) {
                  e.stopPropagation()
                  return
                }
                item.run()
                onClose()
              }}
              onMouseEnter={(e) => {
                if (isSubmenu) {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSubmenu({
                    index: i,
                    submenu: item,
                    x: rect.right,
                    y: rect.top,
                  })
                } else {
                  closeSubmenu()
                }
              }}
            >
              <span className="menu__icon">{item.icon}</span>
              <span className="menu__label">{item.label}</span>
              {isSubmenu && <span className="menu__arrow">▸</span>}
            </div>
          )
        })}
      </div>
      {submenu && (
        <div
          className="menu menu--submenu"
          style={{ left: submenu.x, top: submenu.y }}
          onClick={onClose}
          onMouseLeave={closeSubmenu}
        >
          {submenu.submenu.children.map((child, i) => {
            if (child instanceof MenuSeparator) return <SeparatorRow key={i} />
            if (child instanceof MenuSubmenu) return null
            return (
              <div
                key={i}
                className="menu__item"
                onClick={() => {
                  child.run()
                  onClose()
                }}
              >
                <span className="menu__icon">{child.icon}</span>
                <span className="menu__label">{child.label}</span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
