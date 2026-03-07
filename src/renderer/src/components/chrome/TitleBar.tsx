import type { Component } from 'solid-js';
import './chrome.css';

const TitleBar: Component = () => {
  return (
    <div class="title-bar">
      <div class="title-bar-drag" />
      <div class="window-controls">
        <button
          class="window-btn"
          onClick={() => window.vessel.window.minimize()}
          title="Minimize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="1" y="5" width="8" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          class="window-btn"
          onClick={() => window.vessel.window.maximize()}
          title="Maximize"
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
          title="Close"
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
