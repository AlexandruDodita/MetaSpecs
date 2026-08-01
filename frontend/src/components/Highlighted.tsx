import type { ReactNode } from 'react'
import { tokenize } from '../highlight'
import type { Visibility } from '../types'

export function Highlighted({
  text,
  className,
}: {
  text: string
  className?: string
}): ReactNode {
  const tokens = tokenize(text)
  if (tokens.length === 0) return null
  return (
    <span className={className}>
      {tokens.map((token, i) => (
        <span key={i} className={'hl--' + token.kind}>
          {token.text}
        </span>
      ))}
    </span>
  )
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }): ReactNode {
  const char = visibility === 'public' ? '+' : visibility === 'private' ? '-' : '#'
  return <span className={'vis--' + visibility}>{char}</span>
}
