import { useState } from 'react';
import { NODE_TYPE_CONFIG } from '../config';
import { ChevronIcon } from './icons';
import type { LegendItem, TypeLabels } from '../types';

interface LegendProps {
  customItems?: LegendItem[];
  typeLabels?: TypeLabels;
}

export function Legend({ customItems, typeLabels }: LegendProps) {
  const [isExpanded, setIsExpanded] = useState(false);  // Start collapsed

  // If custom items provided, use those; otherwise derive from NODE_TYPE_CONFIG with optional label overrides
  const legendItems = customItems || Object.entries(NODE_TYPE_CONFIG)
    .filter(([_, config]) => config.showInLegend)
    .sort((a, b) => a[1].legendOrder - b[1].legendOrder)
    .map(([key, config]) => ({
      type: key,
      label: typeLabels?.[key as keyof TypeLabels] || config.label,
      color: config.nodeBg,
      borderColor: config.nodeBg,
    }));

  return (
    <div className={`ceg-legend ${isExpanded ? 'ceg-legend--expanded' : ''}`}>
      <div className="ceg-legend__header" onClick={() => setIsExpanded(!isExpanded)}>
        <span className="ceg-legend__title">Legend</span>
        <ChevronIcon expanded={isExpanded} />
      </div>

      <div className="ceg-legend__content">
        {/* Node Types */}
        <div className="ceg-legend__section">
          <div className="ceg-legend__section-title">Node Types</div>
          {legendItems.map((item) => (
              <div key={item.type} className="ceg-legend__row">
                <div
                  className="ceg-legend__node-swatch"
                  style={{ backgroundColor: item.color, borderColor: item.borderColor }}
                />
                <span>{item.label}</span>
              </div>
            ))}
        </div>

        {/* Arrow Strength */}
        <div className="ceg-legend__section ceg-legend__section--last">
          <div className="ceg-legend__section-title">Arrow Strength</div>
          <div className="ceg-legend__row">
            <div className="ceg-legend__line-container">
              <svg width="24" height="6">
                <line x1="0" y1="3" x2="24" y2="3" stroke="#64748b" strokeWidth="5" />
              </svg>
            </div>
            <span>Strong</span>
          </div>
          <div className="ceg-legend__row">
            <div className="ceg-legend__line-container">
              <svg width="24" height="4">
                <line x1="0" y1="2" x2="24" y2="2" stroke="#64748b" strokeWidth="2" />
              </svg>
            </div>
            <span>Medium</span>
          </div>
          <div className="ceg-legend__row">
            <div className="ceg-legend__line-container">
              <svg width="24" height="2">
                <line x1="0" y1="1" x2="24" y2="1" stroke="#64748b" strokeWidth="1" />
              </svg>
            </div>
            <span>Weak</span>
          </div>
        </div>
      </div>
    </div>
  );
}
