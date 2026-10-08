import React from 'react';
import {
  getDefaultReachByTime,
  toLocalDateString,
  toTomorrowDateString,
} from '../timeUtils';

interface PlannerFormProps {
  fromStop: string;
  setFromStop: (val: string) => void;
  toStop: string;
  setToStop: (val: string) => void;
  reachByDate: string;
  setReachByDate: (val: string) => void;
  reachByTime: string;
  setReachByTime: (val: string) => void;
  humanDeadlinePreview: string | null;
  loading: boolean;
  onSearch: (e?: React.FormEvent) => void;
  onSwap: () => void;
  telemetryMode: 'live' | 'replay';
  replayTimestampContext?: string;
}

export const PlannerForm: React.FC<PlannerFormProps> = ({
  fromStop,
  setFromStop,
  toStop,
  setToStop,
  reachByDate,
  setReachByDate,
  reachByTime,
  setReachByTime,
  humanDeadlinePreview,
  loading,
  onSearch,
  onSwap,
  telemetryMode,
  replayTimestampContext,
}) => {
  const handleApplyPreset = (
    from: string,
    to: string,
    isTomorrow: boolean = false,
    customTime?: string
  ) => {
    setFromStop(from);
    setToStop(to);
    setReachByDate(isTomorrow ? toTomorrowDateString() : toLocalDateString());
    setReachByTime(customTime || getDefaultReachByTime());
  };

  return (
    <section className="planner-card" aria-label="Journey planning parameters">
      <div className="planner-card-header">
        <h2 className="planner-card-title">Plan Your Trip</h2>
        <p className="planner-card-description">
          Find the most reliable bus to reach your stop before your deadline.
        </p>
      </div>

      {telemetryMode === 'replay' && (
        <div className="replay-alert-banner" role="status">
          <div className="replay-banner-badge">ARCHIVED REPLAY</div>
          <p className="replay-banner-text">
            Results are evaluated against historical GPS observations
            {replayTimestampContext ? ` (${replayTimestampContext})` : ' from the archive snapshot'}.
          </p>
        </div>
      )}

      <form onSubmit={onSearch} className="planner-form" noValidate>
        {/* Origin Stop */}
        <div className="form-field-group">
          <label htmlFor="origin-stop-input" className="field-label">
            <span className="dot-marker dot-origin" aria-hidden="true" />
            <span>From (Origin Stop)</span>
          </label>
          <div className="input-with-action">
            <input
              id="origin-stop-input"
              type="text"
              className="text-input"
              value={fromStop}
              onChange={(e) => setFromStop(e.target.value)}
              placeholder="e.g. Mahindra Park, Kashmere Gate"
              disabled={loading}
              autoComplete="off"
              required
            />
            <button
              type="button"
              className="swap-button"
              onClick={onSwap}
              disabled={loading}
              title="Swap origin and destination"
              aria-label="Swap origin and destination stops"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="7" y1="17" x2="17" y2="7" />
                <polyline points="7 7 17 7 17 17" />
              </svg>
            </button>
          </div>
        </div>

        {/* Destination Stop */}
        <div className="form-field-group">
          <label htmlFor="destination-stop-input" className="field-label">
            <span className="dot-marker dot-destination" aria-hidden="true" />
            <span>To (Destination Stop)</span>
          </label>
          <input
            id="destination-stop-input"
            type="text"
            className="text-input"
            value={toStop}
            onChange={(e) => setToStop(e.target.value)}
            placeholder="e.g. Azadpur, GPO, Patel Chowk"
            disabled={loading}
            autoComplete="off"
            required
          />
        </div>

        {/* Reach By (Date & Time in 2-column row) */}
        <div className="form-field-group reach-by-group">
          <div className="reach-by-header">
            <span className="field-label">
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="clock-icon"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Reach by</span>
            </span>
            {humanDeadlinePreview && (
              <span className="deadline-preview-chip" aria-live="polite">
                {humanDeadlinePreview}
              </span>
            )}
          </div>

          <div className="reach-by-row">
            <div className="reach-by-col">
              <label htmlFor="reach-by-date" className="subfield-label">
                Date
              </label>
              <input
                id="reach-by-date"
                type="date"
                className="native-date-input"
                value={reachByDate}
                min={toLocalDateString()}
                onChange={(e) => setReachByDate(e.target.value)}
                disabled={loading}
                required
              />
            </div>
            <div className="reach-by-col">
              <label htmlFor="reach-by-time" className="subfield-label">
                Time
              </label>
              <input
                id="reach-by-time"
                type="time"
                className="native-time-input"
                value={reachByTime}
                onChange={(e) => setReachByTime(e.target.value)}
                disabled={loading}
                required
              />
            </div>
          </div>
        </div>

        {/* Full-width primary action button */}
        <button
          type="submit"
          className="submit-button"
          disabled={loading}
        >
          {loading ? (
            <span className="btn-loading-content">
              <span className="btn-spinner" aria-hidden="true" />
              <span>Finding Best Routes...</span>
            </span>
          ) : (
            'Find Best Routes'
          )}
        </button>

        {/* Quick Corridor Shortcuts */}
        <div className="presets-container" aria-label="Popular corridor shortcuts">
          <span className="presets-caption">Corridors:</span>
          <div className="presets-chips">
            <button
              type="button"
              className="preset-chip"
              onClick={() => handleApplyPreset('Mahindra Park', 'Azadpur')}
              disabled={loading}
            >
              Mahindra Park &rarr; Azadpur
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => handleApplyPreset('ISBT Kashmere Gate', 'GPO')}
              disabled={loading}
            >
              Kashmere Gate &rarr; GPO
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => handleApplyPreset('Dhaula Kuan', 'Patel Chowk Metro Station')}
              disabled={loading}
            >
              Dhaula Kuan &rarr; Patel Chowk
            </button>
            <button
              type="button"
              className="preset-chip"
              onClick={() => handleApplyPreset('Dwarka Sector 22', 'Narela Terminal')}
              disabled={loading}
            >
              Dwarka &rarr; Narela (Direct check)
            </button>
          </div>
        </div>
      </form>
    </section>
  );
};
