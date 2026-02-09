import { useEffect, useRef, useState } from 'react';

interface MermaidProps {
  chart: string;
}

const lightTheme = {
  primaryColor: '#e8f4fc',
  primaryTextColor: '#1a1a2e',
  primaryBorderColor: '#4a90d9',
  secondaryColor: '#f0f7e6',
  secondaryTextColor: '#1a1a2e',
  secondaryBorderColor: '#6b8e23',
  tertiaryColor: '#fff3e0',
  tertiaryTextColor: '#1a1a2e',
  tertiaryBorderColor: '#e67e22',
  lineColor: '#5c6370',
  textColor: '#1a1a2e',
  nodeBorder: '#4a90d9',
  nodeTextColor: '#1a1a2e',
  mainBkg: '#f8f9fa',
  clusterBkg: '#f0f4f8',
  clusterBorder: '#8b9dc3',
  labelColor: '#1a1a2e',
  edgeLabelBackground: '#ffffff',
};

const darkTheme = {
  primaryColor: '#1e3a5f',
  primaryTextColor: '#e8eaed',
  primaryBorderColor: '#5c9ce6',
  secondaryColor: '#2d4a2d',
  secondaryTextColor: '#e8eaed',
  secondaryBorderColor: '#7cb87c',
  tertiaryColor: '#4a3728',
  tertiaryTextColor: '#e8eaed',
  tertiaryBorderColor: '#e6a756',
  lineColor: '#8b95a5',
  textColor: '#e8eaed',
  nodeBorder: '#5c9ce6',
  nodeTextColor: '#e8eaed',
  mainBkg: '#1a1a2e',
  clusterBkg: '#252540',
  clusterBorder: '#5c6b8a',
  labelColor: '#e8eaed',
  edgeLabelBackground: '#2a2a40',
};

function getMermaidConfig(isDark: boolean) {
  return {
    startOnLoad: false,
    theme: 'base' as const,
    securityLevel: 'loose' as const,
    fontFamily: 'inherit',
    themeVariables: isDark ? darkTheme : lightTheme,
  };
}

export function Mermaid({ chart }: MermaidProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDark, setIsDark] = useState(false);

  // Detect dark mode
  useEffect(() => {
    const checkDarkMode = () => {
      const html = document.documentElement;
      const theme = html.getAttribute('data-theme');
      setIsDark(theme === 'dark' ||
        (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches));
    };

    checkDarkMode();

    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', checkDarkMode);

    return () => {
      observer.disconnect();
      mediaQuery.removeEventListener('change', checkDarkMode);
    };
  }, []);

  useEffect(() => {
    const renderChart = async () => {
      if (!containerRef.current) return;

      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize(getMermaidConfig(isDark));

        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg } = await mermaid.render(id, chart);
        setSvg(svg);
        setError(null);
      } catch (err) {
        console.error('Mermaid rendering error:', err);
        setError(err instanceof Error ? err.message : 'Failed to render diagram');
      } finally {
        setLoading(false);
      }
    };

    renderChart();
  }, [chart, isDark]);

  if (error) {
    return (
      <div className="mermaid-error" style={{
        padding: '1rem',
        background: '#fee',
        borderRadius: '4px',
        color: '#c00'
      }}>
        <strong>Diagram Error:</strong> {error}
        <pre style={{ fontSize: '0.75rem', marginTop: '0.5rem', overflow: 'auto' }}>
          {chart}
        </pre>
      </div>
    );
  }

  if (loading || !svg) {
    return (
      <div
        ref={containerRef}
        className="mermaid-diagram"
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          margin: '1.5rem 0',
          padding: '2rem',
          background: 'var(--sl-color-bg-nav, #f5f5f5)',
          borderRadius: '8px',
          minHeight: '100px',
          color: 'var(--sl-color-text-accent, #666)',
        }}
      >
        Loading diagram...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="mermaid-diagram"
      style={{
        display: 'flex',
        justifyContent: 'center',
        margin: '1.5rem 0',
        padding: '1rem',
        background: 'var(--sl-color-bg-nav, #f5f5f5)',
        borderRadius: '8px',
        overflow: 'auto',
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default Mermaid;
