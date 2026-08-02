import type { EditDraft } from '../types'

type NodeMetaBlock = 'table' | 'shape' | 'class' | 'service' | 'file'

interface NodeMetaProps {
  block: NodeMetaBlock
  path: string
  description: string
  onChange: (patch: Partial<Pick<EditDraft, 'path' | 'description'>>) => void
}

/** Path + description edit controls, shared by every node edit panel. */
export function NodeMeta({ block, path, description, onChange }: NodeMetaProps) {
  const cls = `${block}-edit`
  return (
    <>
      <input
        className={`${cls}__input`}
        value={path}
        onChange={(e) => onChange({ path: e.target.value })}
        placeholder="file path"
      />
      <textarea
        className={`${cls}__notes`}
        value={description}
        onChange={(e) => onChange({ description: e.target.value })}
        placeholder="notes (markdown)"
      />
    </>
  )
}
