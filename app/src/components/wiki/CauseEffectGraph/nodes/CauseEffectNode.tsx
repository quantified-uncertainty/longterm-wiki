"use client";

import { useState, useRef, useCallback, useEffect } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { CauseEffectNodeData } from '../types';
import { NODE_TYPE_CONFIG, OUTCOME_COLORS, NODE_BORDER_RADIUS } from '../config';

// Truncate description to reasonable length
function truncateDescription(text: string | undefined, maxLength: number = 350): string {
  if (!text) return '';
  // Strip markdown links and formatting
  const cleaned = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '');
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + '...';
}

// Get a very brief snippet for inline display (one sentence)
function getBriefDescription(text: string | undefined): string {
  if (!text) return '';
  const cleaned = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '');
  // Take first sentence or first 60 chars
  const firstSentence = cleaned.split(/[.!?]/)[0];
  if (firstSentence.length <= 60) return firstSentence + (cleaned.length > firstSentence.length ? '.' : '');
  return firstSentence.slice(0, 60).trim() + '...';
}

export function CauseEffectNode({ data, selected, id }: NodeProps<Node<CauseEffectNodeData>>) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [hoveredSubItemIndex, setHoveredSubItemIndex] = useState<number | null>(null);
  const nodeRef = useRef<HTMLDivElement>(null);
  const nodeType = data.type || 'intermediate';

  const config = NODE_TYPE_CONFIG[nodeType] || NODE_TYPE_CONFIG.intermediate;

  // Get base colors from config, then override for specific outcome nodes
  let colors = {
    bg: config.nodeBg,
    border: config.nodeBorder,
    text: config.nodeText,
    accent: config.nodeAccent,
  };

  // Apply special colors for individual outcome nodes (tier-based valence encoding)
  if (nodeType === 'effect' && id && OUTCOME_COLORS[id]) {
    const outcomeOverride = OUTCOME_COLORS[id];
    colors = {
      bg: outcomeOverride.nodeBg || colors.bg,
      border: outcomeOverride.nodeBorder || colors.border,
      text: outcomeOverride.nodeText || colors.text,
      accent: outcomeOverride.nodeAccent || colors.accent,
    };
  }

  // Color palette map: simple color name -> full color object
  // This allows YAML authors to just say `color: rose` and get consistent styling
  const semanticColorPalettes: Record<string, { bg: string; border: string; text: string; accent: string }> = {
    // Concerning/risk factors (warm reds/pinks)
    rose: { bg: '#fff1f2', border: '#fb7185', text: '#9f1239', accent: '#f43f5e' },
    red: { bg: '#fef2f2', border: '#f87171', text: '#991b1b', accent: '#ef4444' },
    // Positive/intervention factors (greens)
    emerald: { bg: '#ecfdf5', border: '#34d399', text: '#065f46', accent: '#10b981' },
    green: { bg: '#f0fdf4', border: '#4ade80', text: '#166534', accent: '#22c55e' },
    // Structural/policy factors (blues)
    blue: { bg: '#eff6ff', border: '#60a5fa', text: '#1e40af', accent: '#3b82f6' },
    sky: { bg: '#f0f9ff', border: '#38bdf8', text: '#0c4a6e', accent: '#0ea5e9' },
    // Power centers/key actors (teals)
    teal: { bg: '#f0fdfa', border: '#2dd4bf', text: '#115e59', accent: '#14b8a6' },
    cyan: { bg: '#ecfeff', border: '#22d3ee', text: '#164e63', accent: '#06b6d4' },
    // Uncertainties/key questions (purples)
    violet: { bg: '#f5f3ff', border: '#a78bfa', text: '#5b21b6', accent: '#8b5cf6' },
    purple: { bg: '#faf5ff', border: '#c084fc', text: '#6b21a8', accent: '#a855f7' },
    // Warnings/caution (ambers/yellows)
    amber: { bg: '#fffbeb', border: '#fbbf24', text: '#78350f', accent: '#f59e0b' },
    yellow: { bg: '#fefce8', border: '#facc15', text: '#713f12', accent: '#eab308' },
    // Neutral/informational (grays/slates)
    slate: { bg: '#f8fafc', border: '#94a3b8', text: '#334155', accent: '#64748b' },
    gray: { bg: '#f9fafb', border: '#9ca3af', text: '#374151', accent: '#6b7280' },
  };

  // Apply semantic color from simple color name (e.g., `color: rose`)
  if (data.color && semanticColorPalettes[data.color]) {
    const palette = semanticColorPalettes[data.color];
    colors = { ...palette };
  }

  // Apply explicit nodeColors override if provided (highest priority - for legacy/advanced use)
  if (data.nodeColors) {
    colors = {
      bg: data.nodeColors.bg || colors.bg,
      border: data.nodeColors.border || colors.border,
      text: data.nodeColors.text || colors.text,
      accent: data.nodeColors.accent || colors.accent,
    };
  }

  // Apply score-based highlighting when scoreIntensity is set
  // scoreIntensity: 0-1 = valid score intensity, -1 = no score for this dimension
  // Design: White/light backgrounds with colored borders. Higher scores = more saturated border.
  const hasScoreHighlight = data.scoreIntensity !== undefined;
  let scoreBorderWidth = 2;
  let scoreBoxShadow: string | undefined;

  // Color palettes for each highlight color (matching score dot colors)
  const colorPalettes = {
    purple: {
      light: 'rgba(139, 92, 246, 0.8)',   // violet-500
      medium: '#8b5cf6',                   // violet-500
      strong: '#7c3aed',                   // violet-600
      bold: '#6d28d9',                     // violet-700
      text: '#5b21b6',                     // violet-800
      shadow: 'rgba(139, 92, 246, 0.25)',
    },
    red: {
      light: 'rgba(239, 68, 68, 0.8)',     // red-500
      medium: '#ef4444',                    // red-500
      strong: '#dc2626',                    // red-600
      bold: '#b91c1c',                      // red-700
      text: '#991b1b',                      // red-800
      shadow: 'rgba(239, 68, 68, 0.25)',
    },
    green: {
      light: 'rgba(34, 197, 94, 0.8)',     // green-500
      medium: '#22c55e',                    // green-500
      strong: '#16a34a',                    // green-600
      bold: '#15803d',                      // green-700
      text: '#166534',                      // green-800
      shadow: 'rgba(34, 197, 94, 0.25)',
    },
    blue: {
      light: 'rgba(59, 130, 246, 0.8)',    // blue-500
      medium: '#3b82f6',                    // blue-500
      strong: '#2563eb',                    // blue-600
      bold: '#1d4ed8',                      // blue-700
      text: '#1e40af',                      // blue-800
      shadow: 'rgba(59, 130, 246, 0.25)',
    },
    yellow: {
      light: 'rgba(234, 179, 8, 0.8)',     // yellow-500
      medium: '#eab308',                    // yellow-500
      strong: '#ca8a04',                    // yellow-600
      bold: '#a16207',                      // yellow-700
      text: '#854d0e',                      // yellow-800
      shadow: 'rgba(234, 179, 8, 0.25)',
    },
  };

  // Get the active color palette (default to blue)
  const highlightColor = data.highlightColor || 'blue';
  const palette = colorPalettes[highlightColor];

  if (hasScoreHighlight) {
    if (data.scoreIntensity === -1) {
      // No score - very faded, nearly invisible
      colors = {
        bg: '#fafafa',
        border: 'rgba(148, 163, 184, 0.3)', // Very transparent
        text: 'rgba(148, 163, 184, 0.6)',
        accent: 'rgba(148, 163, 184, 0.3)',
      };
      scoreBorderWidth = 1;
    } else {
      const intensity = data.scoreIntensity!;

      // All scored nodes get white/near-white background
      // Border opacity and thickness increase with score
      if (intensity < 0.3) {
        // Low scores (1-3): Very faded, transparent border
        colors = {
          bg: '#fafafa',
          border: 'rgba(148, 163, 184, 0.4)',
          text: 'rgba(100, 116, 139, 0.7)',
          accent: 'rgba(148, 163, 184, 0.4)',
        };
        scoreBorderWidth = 1;
      } else if (intensity < 0.5) {
        // Medium-low scores (4-5): Slightly more visible
        colors = {
          bg: '#ffffff',
          border: 'rgba(100, 116, 139, 0.6)',
          text: '#64748b',
          accent: 'rgba(100, 116, 139, 0.6)',
        };
        scoreBorderWidth = 1.5;
      } else if (intensity < 0.7) {
        // Medium-high scores (6-7): Colored tint, more opaque
        colors = {
          bg: '#ffffff',
          border: palette.light,
          text: palette.text,
          accent: palette.medium,
        };
        scoreBorderWidth = 2;
        scoreBoxShadow = `0 2px 8px ${palette.shadow}`;
      } else if (intensity < 0.9) {
        // High scores (8-9): Stronger color, solid
        colors = {
          bg: '#ffffff',
          border: palette.strong,
          text: palette.text,
          accent: palette.strong,
        };
        scoreBorderWidth = 2.5;
        scoreBoxShadow = `0 4px 12px ${palette.shadow}`;
      } else {
        // Very high scores (10): Bold color with glow
        colors = {
          bg: '#ffffff',
          border: palette.bold,
          text: palette.text,
          accent: palette.bold,
        };
        scoreBorderWidth = 3;
        scoreBoxShadow = `0 4px 16px ${palette.shadow}, 0 0 0 1px rgba(0, 0, 0, 0.05)`;
      }
    }
  }

  // Effect nodes (final/critical nodes) always get gold styling to stand out
  const isEffectNode = nodeType === 'effect';
  let effectBorderWidth = scoreBorderWidth;
  let effectBoxShadow = scoreBoxShadow;
  let effectBackground = colors.bg;

  if (isEffectNode) {
    colors = {
      ...colors,
      bg: '#fffbeb', // amber-50 - warm light background
      border: '#f59e0b', // amber-500 - clean gold border
      accent: '#d97706', // amber-600
      text: '#78350f', // amber-900 for good contrast
    };

    effectBackground = colors.bg;
    effectBorderWidth = 2;
    // No box-shadow to avoid double-border appearance
    effectBoxShadow = 'none';
  }

  // Get border radius based on node type (shapes encode function)
  const borderRadius = NODE_BORDER_RADIUS[nodeType] || '12px';

  const hasSubItems = data.subItems && data.subItems.length > 0;
  const isClickable = !!data.href && !data.suppressNavigation;

  const handleClick = () => {
    if (data.href && !data.suppressNavigation) {
      window.location.href = data.href;
    }
  };

  const handleMouseEnter = useCallback(() => {
    setShowTooltip(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setShowTooltip(false);
  }, []);

  // Raise parent ReactFlow node's z-index when tooltip is visible
  // ReactFlow wraps nodes in .react-flow__node with transform (creates stacking context)
  // Our CSS z-index is trapped in that context, so we must raise the parent
  useEffect(() => {
    if (!nodeRef.current) return;

    const reactFlowNode = nodeRef.current.closest('.react-flow__node') as HTMLElement;
    if (!reactFlowNode) return;

    const originalZIndex = reactFlowNode.style.zIndex;

    if (showTooltip) {
      reactFlowNode.style.zIndex = '10000';
    }

    return () => {
      // Restore original z-index on cleanup
      reactFlowNode.style.zIndex = originalZIndex;
    };
  }, [showTooltip]);

  return (
    <div
      ref={nodeRef}
      className={`ceg-node ${hasSubItems ? 'ceg-node--with-subitems' : ''} ${selected ? 'ceg-node--selected' : ''} ${isClickable ? 'ceg-node--clickable' : ''} ${showTooltip ? 'ceg-node--tooltip-visible' : ''}`}
      style={{
        background: isEffectNode ? effectBackground : colors.bg,
        borderColor: isEffectNode ? colors.border : (selected ? colors.text : colors.border),
        borderRadius: borderRadius,
        borderWidth: (hasScoreHighlight || isEffectNode) ? `${effectBorderWidth}px` : undefined,
        boxShadow: isEffectNode
          ? 'none'
          : (selected ? `0 8px 24px rgba(0,0,0,0.15), 0 0 0 2px ${colors.accent}` : effectBoxShadow),
        cursor: isClickable ? 'pointer' : undefined,
      }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={isClickable ? handleClick : undefined}
    >
      <Handle type="target" position={Position.Top} className="ceg-node__handle" />

      <div className="ceg-node__label" style={{ color: isClickable ? '#2563eb' : colors.text, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
        <span>{data.label}</span>
        {isClickable && (
          <svg
            className="ceg-node__link-icon"
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ opacity: 0.5, flexShrink: 0 }}
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        )}
      </div>

      {/* Brief description snippet - always visible if description exists */}
      {data.description && !hasSubItems && (
        <div className="ceg-node__snippet" style={{ color: `${colors.text}99` }}>
          {getBriefDescription(data.description)}
        </div>
      )}

      {/* Inline score indicators - shown when showScores is enabled */}
      {data.showScores && data.scores && (Object.values(data.scores).some(v => v !== undefined)) && (() => {
        const activeDim = data.activeScoreDimension;
        const getScoreOpacity = (scoreName: string) => {
          if (!activeDim) return 1; // No dimension active = all full opacity
          return scoreName === activeDim ? 1 : 0.3; // Active = full, others faded
        };
        const containerOpacity = hasScoreHighlight && data.scoreIntensity !== undefined && data.scoreIntensity < 0.5
          ? 0.4 + (data.scoreIntensity === -1 ? 0 : data.scoreIntensity * 0.6)
          : 1;
        return (
        <div
          className="ceg-node__scores-inline"
          style={{ opacity: containerOpacity }}
        >
          {data.scores.sensitivity !== undefined && (
            <span className="ceg-node__score-item" style={{ opacity: getScoreOpacity('sensitivity') }} title={`Sensitivity: ${data.scores.sensitivity}/10 — Impact on downstream nodes`}>
              <span className="ceg-node__score-dot" style={{ backgroundColor: '#3b82f6' }} />
              <span className="ceg-node__score-num">{data.scores.sensitivity}</span>
            </span>
          )}
          {data.scores.novelty !== undefined && (
            <span className="ceg-node__score-item" style={{ opacity: getScoreOpacity('novelty') }} title={`Novelty: ${data.scores.novelty}/10 — How surprising to informed readers`}>
              <span className="ceg-node__score-dot" style={{ backgroundColor: '#8b5cf6' }} />
              <span className="ceg-node__score-num">{data.scores.novelty}</span>
            </span>
          )}
          {data.scores.changeability !== undefined && (
            <span className="ceg-node__score-item" style={{ opacity: getScoreOpacity('changeability') }} title={`Changeability: ${data.scores.changeability}/10 — How tractable to influence`}>
              <span className="ceg-node__score-dot" style={{ backgroundColor: '#22c55e' }} />
              <span className="ceg-node__score-num">{data.scores.changeability}</span>
            </span>
          )}
          {data.scores.certainty !== undefined && (
            <span className="ceg-node__score-item" style={{ opacity: getScoreOpacity('certainty') }} title={`Certainty: ${data.scores.certainty}/10 — How well understood`}>
              <span className="ceg-node__score-dot" style={{ backgroundColor: '#ef4444' }} />
              <span className="ceg-node__score-num">{data.scores.certainty}</span>
            </span>
          )}
        </div>
        );
      })()}

      {hasSubItems && (
        <div className="ceg-node__subitems" style={{ borderTopColor: `${colors.border}40` }}>
          {data.subItems!.map((item, i) => {
            const isHovered = hoveredSubItemIndex === i;
            return (
            <div
              key={i}
              className={`ceg-node__subitem ${item.href ? 'ceg-node__subitem--clickable' : ''}`}
              style={{
                backgroundColor: isHovered ? `${colors.border}30` : colors.bg,
                borderColor: `${colors.border}60`,
                color: colors.text,
                cursor: item.href ? 'pointer' : (item.description ? 'help' : 'pointer'),
                position: 'relative',
                transition: 'background-color 0.15s ease',
              }}
              onClick={item.href ? (e) => { e.stopPropagation(); window.location.href = item.href!; } : undefined}
              onMouseEnter={() => setHoveredSubItemIndex(i)}
              onMouseLeave={() => setHoveredSubItemIndex(null)}
            >
              <span className="ceg-node__subitem-label">{item.label}</span>
              {item.probability && (
                <span className="ceg-node__subitem-prob">{item.probability}</span>
              )}
              {isHovered && item.description && (
                <div className="ceg-node__tooltip ceg-node__tooltip--subitem">
                  {truncateDescription(item.description)}
                  <div className="ceg-node__tooltip-arrow" />
                </div>
              )}
            </div>
          );
          })}
        </div>
      )}

      <Handle type="source" position={Position.Bottom} className="ceg-node__handle" />

      {/* Inline tooltip - child of node so hover stays in same DOM tree */}
      {showTooltip && hoveredSubItemIndex === null && (
        <div className="ceg-node__tooltip ceg-node__tooltip--inline ceg-node__tooltip--rich">
          {/* Description */}
          {data.description && (
            <div className="ceg-tooltip__description">
              {truncateDescription(data.description, 280)}
            </div>
          )}

          {/* Scores - compact inline */}
          {data.scores && (Object.values(data.scores).some(v => v !== undefined)) && (
            <div className="ceg-tooltip__scores-compact">
              {data.scores.sensitivity !== undefined && (
                <span className="ceg-tooltip__score-item" title="Sensitivity: Impact on downstream nodes">
                  <span className="ceg-tooltip__score-dot" style={{ backgroundColor: '#3b82f6' }} />
                  <span className="ceg-tooltip__score-num">{data.scores.sensitivity}</span>
                </span>
              )}
              {data.scores.novelty !== undefined && (
                <span className="ceg-tooltip__score-item" title="Novelty: How surprising to informed readers">
                  <span className="ceg-tooltip__score-dot" style={{ backgroundColor: '#8b5cf6' }} />
                  <span className="ceg-tooltip__score-num">{data.scores.novelty}</span>
                </span>
              )}
              {data.scores.changeability !== undefined && (
                <span className="ceg-tooltip__score-item" title="Changeability: How tractable to influence">
                  <span className="ceg-tooltip__score-dot" style={{ backgroundColor: '#22c55e' }} />
                  <span className="ceg-tooltip__score-num">{data.scores.changeability}</span>
                </span>
              )}
              {data.scores.certainty !== undefined && (
                <span className="ceg-tooltip__score-item" title="Certainty: How well understood">
                  <span className="ceg-tooltip__score-dot" style={{ backgroundColor: '#ef4444' }} />
                  <span className="ceg-tooltip__score-num">{data.scores.certainty}</span>
                </span>
              )}
            </div>
          )}

          {/* Metadata row */}
          {(data.confidence !== undefined || data.type || data.subgroup) && (
            <div className="ceg-tooltip__meta">
              {data.type && (
                <span className="ceg-tooltip__tag ceg-tooltip__tag--type">
                  {data.type}
                </span>
              )}
              {data.subgroup && (
                <span className="ceg-tooltip__tag ceg-tooltip__tag--subgroup">
                  {data.subgroup.replace(/-/g, ' ')}
                </span>
              )}
              {data.confidence !== undefined && (
                <span className="ceg-tooltip__tag ceg-tooltip__tag--confidence">
                  {Math.round(data.confidence * 100)}% confidence
                </span>
              )}
            </div>
          )}

          {/* Related concepts */}
          {data.relatedConcepts && data.relatedConcepts.length > 0 && (
            <div className="ceg-tooltip__related">
              <span className="ceg-tooltip__related-label">Related:</span>
              {data.relatedConcepts.slice(0, 3).join(', ')}
              {data.relatedConcepts.length > 3 && ` +${data.relatedConcepts.length - 3} more`}
            </div>
          )}

          {/* View details link hint */}
          {data.href && (
            <div className="ceg-tooltip__action">
              Click to view details →
            </div>
          )}

          {/* No description fallback */}
          {!data.description && !data.confidence && !data.relatedConcepts?.length && (
            <div className="ceg-tooltip__empty">
              {data.href ? 'Click to view details' : 'No additional information'}
            </div>
          )}

          <div className="ceg-node__tooltip-arrow" />
        </div>
      )}
    </div>
  );
}
