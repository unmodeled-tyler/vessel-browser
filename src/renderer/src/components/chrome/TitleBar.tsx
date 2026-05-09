import { createSignal, onCleanup, onMount, type Component } from 'solid-js';
import type { RuntimeHealthState } from '../../../shared/types';
import './chrome.css';

const TitleBar: Component<{ onOpenDownloads?: () => void }> = (props) => {
  const isPrivateWindow = new URLSearchParams(window.location.search).get("private") === "1";
  const [mcpStatus, setMcpStatus] = createSignal<'ready' | 'error' | 'starting' | 'stopped'>('starting');
  const [mcpTooltip, setMcpTooltip] = createSignal('MCP: starting...');

  const applyHealth = (health: RuntimeHealthState) => {
    setMcpStatus(health.mcp.status as 'ready' | 'error' | 'starting' | 'stopped');
    if (health.mcp.status === 'ready') {
      setMcpTooltip(`MCP ready — ${health.mcp.endpoint}`);
    } else if (health.mcp.status === 'error') {
      setMcpTooltip(`MCP error: ${health.mcp.message}`);
    } else {
      setMcpTooltip(`MCP: ${health.mcp.status}`);
    }
  };

  const loadHealth = async () => {
    try {
      applyHealth(await window.vessel.settings.getHealth());
    } catch {
      setMcpStatus('error');
      setMcpTooltip('MCP: status unavailable');
    }
  };

  onMount(() => {
    void loadHealth();
    const unsubscribe = window.vessel.settings.onHealthUpdate(applyHealth);
    onCleanup(unsubscribe);
  });

  const handleMcpClick = () => {
    if (isPrivateWindow) return;
    window.vessel.ui.setSettingsVisibility(true);
  };

  return (
    <div class="title-bar">
      <div class="title-bar-drag" />
      <div class="mcp-status-area">
        <button
          class="mcp-status-indicator"
          classList={{
            'mcp-ready': mcpStatus() === 'ready',
            'mcp-error': mcpStatus() === 'error',
            'mcp-starting': mcpStatus() === 'starting' || mcpStatus() === 'stopped',
          }}
          onClick={handleMcpClick}
          title={mcpTooltip()}
        >
          <span class="mcp-dot" />
          <span class="mcp-label">MCP</span>
        </button>
      </div>
      <div class="window-controls">
        <button
          class="window-btn"
          onClick={() => props.onOpenDownloads?.()}
          data-tooltip="Downloads"
        >
          ↓
        </button>
        <button
          class="window-btn"
          onClick={() => window.vessel.window.minimize()}
          data-tooltip="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          class="window-btn"
          onClick={() => window.vessel.window.maximize()}
          data-tooltip="Maximize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect
              x="1"
              y="1"
              width="8"
              height="8"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
            />
          </svg>
        </button>
        <button
          class="window-btn window-btn-close"
          onClick={() => window.vessel.window.close()}
          data-tooltip="Close"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line
              x1="1"
              y1="1"
              x2="9"
              y2="9"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <line
              x1="9"
              y1="1"
              x2="1"
              y2="9"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
