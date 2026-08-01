import type { NodeProps } from '@xyflow/react'
import type { PreviewNodeData } from '../types'

export default function PreviewNode({ data }: NodeProps) {
  const kind = (data as PreviewNodeData).kind ?? 'rect'

  if (kind === 'table') {
    return (
      <div className="table-node table-node--ghost">
        <div className="schema__header">
          <span className="schema__name">table</span>
          <span className="schema__badge">TABLE</span>
        </div>
        <table className="schema__grid">
          <tbody>
            <tr className="schema__row">
              <td className="schema__col-name">id</td>
            </tr>
            <tr className="schema__row">
              <td className="schema__col-name">name</td>
            </tr>
          </tbody>
        </table>
      </div>
    )
  }

  if (kind === 'circle') {
    return (
      <div className="shape-node shape-node--ghost shape-node--circle">
        <div className="shape-node__inner shape-node__inner--circle">
          <div className="shape-node__clabel">circle</div>
        </div>
      </div>
    )
  }

  return (
    <div className="shape-node shape-node--ghost">
      <div className="shape-node__inner">
        <div className="shape-node__header">rect</div>
      </div>
    </div>
  )
}
