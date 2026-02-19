import type { Node } from '@xyflow/react';
import type { CauseEffectNodeData } from '../types';

interface DetailsPanelProps {
  node: Node<CauseEffectNodeData> | null;
  onClose: () => void;
}

export function DetailsPanel({ node, onClose }: DetailsPanelProps) {
  if (!node) return null;
  const data = node.data;
  const nodeType = data.type || 'intermediate';

  return (
    <div className="cause-effect-graph__panel">
      <div className="cause-effect-graph__panel-header">
        <div>
          <span className={`cause-effect-graph__panel-badge cause-effect-graph__panel-badge--${nodeType}`}>
            {nodeType.charAt(0).toUpperCase() + nodeType.slice(1)}
          </span>
          <h3 className="cause-effect-graph__panel-title">{data.label}</h3>
        </div>
        <button className="cause-effect-graph__panel-close" onClick={onClose} aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="cause-effect-graph__panel-content">
        {data.href && (
          <div className="cause-effect-graph__panel-section">
            <a
              href={data.href}
              className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 no-underline"
            >
              View wiki page →
            </a>
          </div>
        )}
        {data.confidence !== undefined && (
          <div className="cause-effect-graph__panel-section">
            <div className="cause-effect-graph__panel-label">
              {data.confidenceLabel
                ? `${data.confidenceLabel.charAt(0).toUpperCase()}${data.confidenceLabel.slice(1)}`
                : 'Confidence Level'}
            </div>
            {data.confidence <= 1 ? (
              <div className="cause-effect-graph__progress">
                <div className="cause-effect-graph__progress-bar">
                  <div
                    className="cause-effect-graph__progress-fill"
                    style={{ width: `${data.confidence * 100}%` }}
                  />
                </div>
                <span className="cause-effect-graph__progress-value">
                  {Math.round(data.confidence * 100)}%
                </span>
              </div>
            ) : (
              <span className="cause-effect-graph__progress-value">
                {Math.round(data.confidence)}
              </span>
            )}
          </div>
        )}
        {data.description && (
          <div className="cause-effect-graph__panel-section">
            <div className="cause-effect-graph__panel-label">Description</div>
            <p className="cause-effect-graph__panel-text">{data.description}</p>
          </div>
        )}
        {data.details && (
          <div className="cause-effect-graph__panel-section">
            <div className="cause-effect-graph__panel-label">Details</div>
            <p className="cause-effect-graph__panel-text">{data.details}</p>
          </div>
        )}
        {data.relatedConcepts && data.relatedConcepts.length > 0 && (
          <div className="cause-effect-graph__panel-section">
            <div className="cause-effect-graph__panel-label">Related Concepts</div>
            <div className="cause-effect-graph__panel-tags">
              {data.relatedConcepts.map((concept, i) => (
                <span key={i} className="cause-effect-graph__panel-tag">
                  {concept}
                </span>
              ))}
            </div>
          </div>
        )}
        {data.sources && data.sources.length > 0 && (
          <div className="cause-effect-graph__panel-section">
            <div className="cause-effect-graph__panel-label">Sources</div>
            <ul className="ceg-panel-sources">
              {data.sources.map((source, i) => (
                <li key={i}>{source}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
