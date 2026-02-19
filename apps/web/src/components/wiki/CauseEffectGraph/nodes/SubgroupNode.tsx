import type { NodeProps, Node } from '@xyflow/react';
import type { CauseEffectNodeData } from '../types';

export function SubgroupNode({ data }: NodeProps<Node<CauseEffectNodeData>>) {
  return (
    <div className="ceg-subgroup-node">
      <div className="ceg-subgroup-node__label">
        {data.label}
      </div>
    </div>
  );
}
