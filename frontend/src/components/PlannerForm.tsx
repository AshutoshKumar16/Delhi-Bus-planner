import React, { useEffect, useId, useRef, useState } from 'react';
import { fetchReachableDestinations, fetchStopSearch } from '../api';
import {
  getDefaultReachByTime,
  toLocalDateString,
  toTomorrowDateString,
  VERIFIED_REPLAY_DATE,
  VERIFIED_REPLAY_TIME,
} from '../timeUtils';
import type { ReachableDestination, StopSearchResult } from '../types';

interface PlannerFormProps {
  fromStop: string;
  setFromStop: (val: string) => void;
  fromStopId?: string | null;
  setFromStopId?: (val: string | null) => void;
  toStop: string;
  setToStop: (val: string) => void;
  toStopId?: string | null;
  setToStopId?: (val: string | null) => void;
  reachByDate: string;
  setReachByDate: (val: string) => void;
  reachByTime: string;
  setReachByTime: (val: string) => void;
  humanDeadlinePreview: string | null;
  loading: boolean;
  onSearch: (e?: React.FormEvent) => void;
  onSwap: () => void;
  telemetryMode: 'live' | 'replay';
  replayDate?: string;
  setReplayDate?: (val: string) => void;
  replayTime?: string;
  setReplayTime?: (val: string) => void;
  onApplyReplayPreset?: () => void;
  resolvedSnapshotPath?: string;
  resolvedSnapshotAgeSeconds?: number;
  replayTimestampContext?: string;
}

export const PlannerForm: React.FC<PlannerFormProps> = ({
  fromStop,
  setFromStop,
  fromStopId,
  setFromStopId,
  toStop,
  setToStop,
  toStopId,
  setToStopId,
  reachByDate,
  setReachByDate,
  reachByTime,
  setReachByTime,
  humanDeadlinePreview,
  loading,
  onSearch,
  onSwap,
  telemetryMode,
  replayDate = VERIFIED_REPLAY_DATE,
  setReplayDate,
  replayTime = VERIFIED_REPLAY_TIME,
  setReplayTime,
  onApplyReplayPreset,
  resolvedSnapshotPath,
  resolvedSnapshotAgeSeconds,
  replayTimestampContext,
}) => {
  const fromListboxId = useId();
  const toListboxId = useId();

  // Autocomplete and Suggestions State
  const [fromSuggestions, setFromSuggestions] = useState<StopSearchResult[]>([]);
  const [fromLoading, setFromLoading] = useState<boolean>(false);
  const [showFromDropdown, setShowFromDropdown] = useState<boolean>(false);

  const [toSuggestions, setToSuggestions] = useState<StopSearchResult[]>([]);
  const [toLoading, setToLoading] = useState<boolean>(false);
  const [showToDropdown, setShowToDropdown] = useState<boolean>(false);

  const [destinations, setDestinations] = useState<ReachableDestination[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState<boolean>(false);

  const fromWrapperRef = useRef<HTMLDivElement>(null);
  const toWrapperRef = useRef<HTMLDivElement>(null);

  // When an origin stop ID is known, fetch its downstream destinations.
  // Fix: clear stale destinations immediately on origin change, guard against
  // out-of-order async responses, and prevent older finally blocks from
  // resetting the loading state owned by a newer request.
  useEffect(() => {
    // Synchronous reset is intentional here: we must clear the previous
    // origin's destinations before the new async fetch resolves so that stale
    // data is never shown under a different origin.
    // oxlint-disable-next-line react/set-state-in-effect
    setDestinations([]);

    if (!fromStopId) {
      setDestinationsLoading(false);
      return;
    }

    setDestinationsLoading(true);

    const controller = new AbortController();

    fetchReachableDestinations(fromStopId, 50, controller.signal)
      .then((data) => {
        // Guard: only commit results if this request was not aborted.
        // If a newer effect ran first and aborted this controller, we skip the
        // write so a faster newer response already committed stays intact.
        if (!controller.signal.aborted) {
          setDestinations(data.destinations || []);
        }
      })
      .catch(() => {
        // On a genuine (non-abort) error, clear destinations so stale data
        // from the previous origin is not shown.
        if (!controller.signal.aborted) {
          setDestinations([]);
        }
      })
      .finally(() => {
        // Only reset loading if this request is still the active one.
        // An aborted controller means a newer effect has taken ownership of
        // the loading state, so we must not interfere.
        if (!controller.signal.aborted) {
          setDestinationsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [fromStopId]);

  // Debounced search for From stop
  useEffect(() => {
    if (!showFromDropdown || fromStop.trim().length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setFromLoading(true);
      fetchStopSearch(fromStop.trim(), 10, controller.signal)
        .then((res) => {
          setFromSuggestions(res.stops || []);
        })
        .catch(() => {
          // ignore aborts
        })
        .finally(() => {
          setFromLoading(false);
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [fromStop, showFromDropdown]);

  // Debounced search for To stop
  useEffect(() => {
    if (!showToDropdown || toStop.trim().length < 2) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setToLoading(true);
      fetchStopSearch(toStop.trim(), 10, controller.signal)
        .then((res) => {
          setToSuggestions(res.stops || []);
        })
        .catch(() => {
          // ignore aborts
        })
        .finally(() => {
          setToLoading(false);
        });
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [toStop, showToDropdown]);

  // Handle outside click & escape key
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        fromWrapperRef.current &&
        !fromWrapperRef.current.contains(e.target as Node)
      ) {
        setShowFromDropdown(false);
      }
      if (
        toWrapperRef.current &&
        !toWrapperRef.current.contains(e.target as Node)
      ) {
        setShowToDropdown(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowFromDropdown(false);
        setShowToDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleApplyPreset = (
    from: string,
    to: string,
    isTomorrow: boolean = false,
    customTime?: string
  ) => {
    setFromStop(from);
    setFromStopId?.(null);
    setToStop(to);
    setToStopId?.(null);
    setDestinations([]);
    setFromSuggestions([]);
    setToSuggestions([]);
    setShowFromDropdown(false);
    setShowToDropdown(false);
    if (telemetryMode === 'replay') {
      if (setReplayDate) setReplayDate(VERIFIED_REPLAY_DATE);
      if (setReplayTime) setReplayTime(VERIFIED_REPLAY_TIME);
      setReachByDate(VERIFIED_REPLAY_DATE);
      setReachByTime('07:35:00');
    } else {
      setReachByDate(isTomorrow ? toTomorrowDateString() : toLocalDateString());
      setReachByTime(customTime || getDefaultReachByTime());
    }
  };

  const handleSwapWithDropdownClose = () => {
    setShowFromDropdown(false);
    setShowToDropdown(false);
    onSwap();
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
            {resolvedSnapshotPath ? (
              <>
                Resolved snapshot: <strong>{resolvedSnapshotPath}</strong>
                {resolvedSnapshotAgeSeconds != null ? ` (${resolvedSnapshotAgeSeconds}s age)` : ''}
                {replayTimestampContext ? ` at ${replayTimestampContext}` : ''}.
              </>
            ) : (
              <>
                Evaluating corridor against historical GPS telemetry at{' '}
                <strong>{replayDate} {replayTime}</strong>.
              </>
            )}
          </p>
        </div>
      )}

      <form onSubmit={onSearch} className="planner-form" noValidate>
        {/* Replay Historical Observation Time (P) */}
        {telemetryMode === 'replay' && (
          <div className="form-field-group historical-time-group">
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
                <span>Historical Observation Time (P)</span>
              </span>
              {onApplyReplayPreset && (
                <button
                  type="button"
                  className="preset-chip"
                  style={{ fontSize: '0.68rem', padding: '1px 6px', height: '22px' }}
                  onClick={onApplyReplayPreset}
                  disabled={loading}
                  title="Load verified out-of-sample snapshot: 2026-10-06 07:05:02 IST"
                >
                  Verified Slice (07:05:02)
                </button>
              )}
            </div>

            <div className="reach-by-row">
              <div className="reach-by-col">
                <label htmlFor="replay-date-input" className="subfield-label">
                  Observation Date
                </label>
                <input
                  id="replay-date-input"
                  type="date"
                  className="native-date-input"
                  value={replayDate}
                  onChange={(e) => setReplayDate?.(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
              <div className="reach-by-col">
                <label htmlFor="replay-time-input" className="subfield-label">
                  Observation Time (IST)
                </label>
                <input
                  id="replay-time-input"
                  type="time"
                  step="1"
                  className="native-time-input"
                  value={replayTime}
                  onChange={(e) => setReplayTime?.(e.target.value)}
                  disabled={loading}
                  required
                />
              </div>
            </div>
          </div>
        )}

        {/* Origin Stop */}
        <div className="form-field-group">
          <label htmlFor="origin-stop-input" className="field-label">
            <span className="dot-marker dot-origin" aria-hidden="true" />
            <span>From (Origin Stop)</span>
            {fromStopId && (
              <span className="selected-stop-badge" title="Selected physical pole ID">
                {fromStopId}
              </span>
            )}
          </label>
          <div className="input-with-action">
            <div className="stop-autocomplete-wrapper" ref={fromWrapperRef}>
              <input
                id="origin-stop-input"
                type="text"
                className="text-input"
                value={fromStop}
                onChange={(e) => {
                  setFromStop(e.target.value);
                  setFromStopId?.(null);
                  if (e.target.value.trim().length >= 2) {
                    setShowFromDropdown(true);
                  } else {
                    setShowFromDropdown(false);
                  }
                }}
                onFocus={() => {
                  if (fromStop.trim().length >= 2) {
                    setShowFromDropdown(true);
                  }
                }}
                placeholder="e.g. Mahindra Park, Kashmere Gate, STOP_04160"
                disabled={loading}
                autoComplete="off"
                role="combobox"
                aria-expanded={showFromDropdown}
                aria-autocomplete="list"
                aria-controls={fromListboxId}
                required
              />
              {showFromDropdown && (
                <ul
                  id={fromListboxId}
                  className="stop-dropdown"
                  role="listbox"
                  aria-label="Origin stop suggestions"
                >
                  {fromLoading && (
                    <li className="stop-dropdown-status" role="status">
                      Searching stops...
                    </li>
                  )}
                  {!fromLoading && fromSuggestions.length === 0 && (
                    <li className="stop-dropdown-status">
                      No stops found matching "{fromStop.trim()}"
                    </li>
                  )}
                  {!fromLoading &&
                    fromSuggestions.map((stop) => (
                      <li
                        key={stop.stop_id}
                        className="stop-suggestion-item"
                        role="option"
                        aria-selected={fromStopId === stop.stop_id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setFromStop(stop.display_name);
                          setFromStopId?.(stop.stop_id);
                          setDestinationsLoading(true);
                          setShowFromDropdown(false);
                        }}
                      >
                        <div className="stop-suggestion-main">
                          <span className="stop-suggestion-name">{stop.display_name}</span>
                          <span className="stop-suggestion-id">{stop.stop_id}</span>
                        </div>
                        <div className="stop-suggestion-details">
                          <span className="stop-suggestion-coords">
                            {stop.lat.toFixed(4)}°N, {stop.lon.toFixed(4)}°E
                          </span>
                          <span className="stop-suggestion-dot" aria-hidden="true">·</span>
                          <span className="stop-suggestion-routes">
                            {stop.route_direction_count}{' '}
                            {stop.route_direction_count === 1 ? 'route' : 'routes'}
                          </span>
                        </div>
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="swap-button"
              onClick={handleSwapWithDropdownClose}
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
            {toStopId && (
              <span className="selected-stop-badge" title="Selected physical pole ID">
                {toStopId}
              </span>
            )}
          </label>
          <div className="stop-autocomplete-wrapper" ref={toWrapperRef}>
            <input
              id="destination-stop-input"
              type="text"
              className="text-input"
              value={toStop}
              onChange={(e) => {
                const val = e.target.value;
                setToStop(val);
                setToStopId?.(null);
                if (val.trim().length < 2) {
                  setToSuggestions([]);
                }
                setShowToDropdown(true);
              }}
              onFocus={() => {
                setShowToDropdown(true);
              }}
              placeholder="e.g. Azadpur, GPO, Patel Chowk"
              disabled={loading}
              autoComplete="off"
              role="combobox"
              aria-expanded={showToDropdown}
              aria-autocomplete="list"
              aria-controls={toListboxId}
              required
            />
            {showToDropdown && (
              <ul
                id={toListboxId}
                className="stop-dropdown"
                role="listbox"
                aria-label="Destination stop suggestions"
              >
                {/* Mode 1: User typed >= 2 characters -> Show Search Results */}
                {toStop.trim().length >= 2 ? (
                  <>
                    {toLoading && (
                      <li className="stop-dropdown-status" role="status">
                        Searching stops...
                      </li>
                    )}
                    {!toLoading && toSuggestions.length === 0 && (
                      <li className="stop-dropdown-status">
                        No stops found matching "{toStop.trim()}"
                      </li>
                    )}
                    {!toLoading &&
                      toSuggestions.map((stop) => (
                        <li
                          key={stop.stop_id}
                          className="stop-suggestion-item"
                          role="option"
                          aria-selected={toStopId === stop.stop_id}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setToStop(stop.display_name);
                            setToStopId?.(stop.stop_id);
                            setShowToDropdown(false);
                          }}
                        >
                          <div className="stop-suggestion-main">
                            <span className="stop-suggestion-name">{stop.display_name}</span>
                            <span className="stop-suggestion-id">{stop.stop_id}</span>
                          </div>
                          <div className="stop-suggestion-details">
                            <span className="stop-suggestion-coords">
                              {stop.lat.toFixed(4)}°N, {stop.lon.toFixed(4)}°E
                            </span>
                            <span className="stop-suggestion-dot" aria-hidden="true">·</span>
                            <span className="stop-suggestion-routes">
                              {stop.route_direction_count}{' '}
                              {stop.route_direction_count === 1 ? 'route' : 'routes'}
                            </span>
                          </div>
                        </li>
                      ))}
                  </>
                ) : (
                  /* Mode 2: User has selected Origin -> Show Reachable Downstream Destinations */
                  <>
                    {destinationsLoading && (
                      <li className="stop-dropdown-status" role="status">
                        Loading downstream destinations...
                      </li>
                    )}
                    {!destinationsLoading && fromStopId && destinations.length > 0 && (
                      <>
                        <li className="stop-dropdown-header" role="presentation">
                          <span className="stop-dropdown-header-title">
                            Reachable Destinations from {fromStop} ({destinations.length})
                          </span>
                          <span className="stop-dropdown-header-subtitle">
                            Structural Route Network · Not live bus availability
                          </span>
                        </li>
                        {destinations.map((dest) => (
                          <li
                            key={dest.stop_id}
                            className="stop-suggestion-item"
                            role="option"
                            aria-selected={toStopId === dest.stop_id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setToStop(dest.display_name);
                              setToStopId?.(dest.stop_id);
                              setShowToDropdown(false);
                            }}
                          >
                            <div className="stop-suggestion-main">
                              <span className="stop-suggestion-name">{dest.display_name}</span>
                              <span className="stop-suggestion-id">{dest.stop_id}</span>
                            </div>
                            <div className="stop-suggestion-details">
                              <span className="stop-suggestion-badge">Downstream</span>
                              <span className="stop-suggestion-routes">
                                {dest.serving_direction_count} direct{' '}
                                {dest.serving_direction_count === 1 ? 'route' : 'routes'}
                              </span>
                            </div>
                          </li>
                        ))}
                      </>
                    )}
                    {!destinationsLoading && (!fromStopId || destinations.length === 0) && (
                      <li className="stop-dropdown-status">
                        {fromStopId
                          ? 'No direct downstream destinations from this origin pole.'
                          : 'Select an origin stop above to see reachable destinations, or type to search.'}
                      </li>
                    )}
                  </>
                )}
              </ul>
            )}
          </div>
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
                min={telemetryMode === 'replay' ? replayDate : toLocalDateString()}
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
