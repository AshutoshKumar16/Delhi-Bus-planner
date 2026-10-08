import React from 'react';
import type { HealthCheckResponse } from '../types';

interface TopBarProps {
  telemetryMode: 'live' | 'replay';
  onModeChange: (mode: 'live' | 'replay') => void;
  health: HealthCheckResponse | null;
  healthError: string | null;
}

export const TopBar: React.FC<TopBarProps> = ({
  telemetryMode,
  onModeChange,
  health,
  healthError,
}) => {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="topbar-brand">
          <div className="brand-icon-box" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="3" width="16" height="15" rx="2" />
              <line x1="4" y1="11" x2="20" y2="11" />
              <circle cx="8" cy="15" r="1" />
              <circle cx="16" cy="15" r="1" />
              <path d="M6 18v2" />
              <path d="M18 18v2" />
            </svg>
          </div>
          <div>
            <h1 className="brand-title">Delhi Bus Planner</h1>
            <p className="brand-tagline">Probabilistic Journey Planning</p>
          </div>
        </div>

        <div className="topbar-actions">
          {/* Segmented Live / Replay Control */}
          <div className="mode-segmented-control" role="group" aria-label="Telemetry mode">
            <button
              type="button"
              className={`mode-seg-btn ${telemetryMode === 'live' ? 'active' : ''}`}
              onClick={() => onModeChange('live')}
              aria-pressed={telemetryMode === 'live'}
              title="Evaluate using current live transit telemetry"
            >
              <span className="mode-status-dot dot-live" aria-hidden="true" />
              <span>Live</span>
            </button>
            <button
              type="button"
              className={`mode-seg-btn ${telemetryMode === 'replay' ? 'active' : ''}`}
              onClick={() => onModeChange('replay')}
              aria-pressed={telemetryMode === 'replay'}
              title="Evaluate using historical archive replay"
            >
              <span className="mode-status-dot dot-replay" aria-hidden="true" />
              <span>Replay</span>
            </button>
          </div>

          {/* System Connection Status */}
          <div className="system-status-chip">
            {health ? (
              <span className="status-badge status-healthy" title="Backend service connected">
                <span className="status-indicator-dot" aria-hidden="true" />
                <span>Connected</span>
              </span>
            ) : healthError ? (
              <span className="status-badge status-offline" title={healthError}>
                <span className="status-indicator-dot" aria-hidden="true" />
                <span>Offline</span>
              </span>
            ) : (
              <span className="status-badge status-checking">
                <span className="status-indicator-dot" aria-hidden="true" />
                <span>Connecting...</span>
              </span>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
