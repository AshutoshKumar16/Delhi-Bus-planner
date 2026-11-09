import React, { useEffect, useMemo, useState } from 'react';
import { fetchHealth, fetchJourneyRecommendation, type ApiError } from './api';
import type {
  CandidateBus,
  HealthCheckResponse,
  JourneyRecommendRequest,
  JourneyRecommendResponse,
} from './types';
import {
  combineDateAndTimeToUnix,
  getDefaultReachByTime,
  getHumanDeadlinePreview,
  parseDateTimeToUnix,
  toLocalDateString,
  VERIFIED_REPLAY_DATE,
  VERIFIED_REPLAY_TIME,
} from './timeUtils';
import { useMediaQuery } from './hooks/useMediaQuery';
import { TopBar } from './components/TopBar';
import { PlannerForm } from './components/PlannerForm';
import { RecommendationCard } from './components/RecommendationCard';
import { EvidenceDisclosure } from './components/EvidenceDisclosure';
import { AlternativesList } from './components/AlternativesList';
import { MapPanel } from './components/MapPanel';
import './App.css';

interface ErrorState {
  title: string;
  message: string;
  errorType?: string;
}

/**
 * Calculates a default arrival deadline 30 minutes after an observation timestamp,
 * handling hour, midnight, and calendar rollovers cleanly with strict validation.
 * Malformed or out-of-range inputs are never silently normalized or converted to 00:00.
 */
function calculateReplayDeadline(
  dateStr: string,
  timeStr: string
): { reachByDate: string; reachByTime: string } {
  const trimmedDate = (dateStr || '').trim();
  const trimmedTime = (timeStr || '').trim();

  // 1. Strict YYYY-MM-DD date validation
  const dateMatch = trimmedDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) {
    return { reachByDate: dateStr, reachByTime: timeStr };
  }

  const year = parseInt(dateMatch[1], 10);
  const month = parseInt(dateMatch[2], 10) - 1;
  const day = parseInt(dateMatch[3], 10);

  // UTC component round-trip check to prevent silent date rollover (e.g. Feb 31 -> Mar 3)
  const checkUtcMs = Date.UTC(year, month, day, 0, 0, 0, 0);
  if (isNaN(checkUtcMs)) {
    return { reachByDate: dateStr, reachByTime: timeStr };
  }
  const checkDate = new Date(checkUtcMs);
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month ||
    checkDate.getUTCDate() !== day
  ) {
    return { reachByDate: dateStr, reachByTime: timeStr };
  }

  // 2. Strict time validation anchored with ^ and $
  const timeRegex = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([aApP][mM])?$/;
  const match = trimmedTime.match(timeRegex);
  if (!match) {
    return { reachByDate: dateStr, reachByTime: timeStr };
  }

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] !== undefined ? parseInt(match[3], 10) : 0;
  const ampm = match[4]?.toUpperCase();

  // Validate minute and second ranges (0–59)
  if (minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return { reachByDate: dateStr, reachByTime: timeStr };
  }

  // Validate hour ranges (0–23 for 24h, 1–12 for 12h)
  if (ampm) {
    if (hours < 1 || hours > 12) {
      return { reachByDate: dateStr, reachByTime: timeStr };
    }
    if (ampm === 'PM' && hours < 12) {
      hours += 12;
    } else if (ampm === 'AM' && hours === 12) {
      hours = 0;
    }
  } else {
    if (hours < 0 || hours > 23) {
      return { reachByDate: dateStr, reachByTime: timeStr };
    }
  }

  // 3. Valid input: advance by 30 minutes in UTC
  const futureMs = Date.UTC(year, month, day, hours, minutes + 30, seconds, 0);
  const d = new Date(futureMs);

  const nextYear = d.getUTCFullYear();
  const nextMonth = String(d.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(d.getUTCDate()).padStart(2, '0');
  const nextHours = String(d.getUTCHours()).padStart(2, '0');
  const nextMinutes = String(d.getUTCMinutes()).padStart(2, '0');
  const nextSeconds = String(d.getUTCSeconds()).padStart(2, '0');

  const timeOut = match[3] !== undefined
    ? `${nextHours}:${nextMinutes}:${nextSeconds}`
    : `${nextHours}:${nextMinutes}`;

  return {
    reachByDate: `${nextYear}-${nextMonth}-${nextDay}`,
    reachByTime: timeOut,
  };
}

export const App: React.FC = () => {
  // Screen size check: desktop is >= 1024px
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  // Form State
  const [fromStop, setFromStop] = useState<string>('Mahindra Park');
  const [fromStopId, setFromStopId] = useState<string | null>(null);
  const [toStop, setToStop] = useState<string>('Azadpur');
  const [toStopId, setToStopId] = useState<string | null>(null);
  const [reachByDate, setReachByDate] = useState<string>(() => toLocalDateString());
  const [reachByTime, setReachByTime] = useState<string>(() => getDefaultReachByTime());

  // Telemetry Mode ('live' | 'replay')
  const [telemetryMode, setTelemetryMode] = useState<'live' | 'replay'>('live');

  // Replay Observation Time State (defaults to verified out-of-sample slice)
  const [replayDate, setReplayDate] = useState<string>(VERIFIED_REPLAY_DATE);
  const [replayTime, setReplayTime] = useState<string>(VERIFIED_REPLAY_TIME);

  // Async States
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [result, setResult] = useState<JourneyRecommendResponse | null>(null);

  // Selected candidate vehicle ID override (when user clicks an alternative)
  const [selectedIdOverride, setSelectedIdOverride] = useState<string | null>(null);

  // Health Status
  const [health, setHealth] = useState<HealthCheckResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  // Derived selected vehicle ID: defaults to recommended bus, or first candidate
  const selectedVehicleId =
    selectedIdOverride ??
    result?.recommended_candidate?.vehicle_id ??
    result?.alternative_candidates?.[0]?.vehicle_id ??
    '';

  // Human-friendly preview of selected deadline (e.g. "Today · 8:15 PM")
  const humanDeadlinePreview = useMemo(() => {
    return getHumanDeadlinePreview(reachByDate, reachByTime);
  }, [reachByDate, reachByTime]);

  // Load system health on mount
  useEffect(() => {
    fetchHealth()
      .then((data) => setHealth(data))
      .catch((err) => setHealthError(err.message));
  }, []);

  const handleModeChange = (mode: 'live' | 'replay') => {
    setTelemetryMode(mode);
    setError(null);
    setSelectedIdOverride(null);
    if (mode === 'replay') {
      const { reachByDate: syncDate, reachByTime: syncTime } = calculateReplayDeadline(
        replayDate,
        replayTime
      );
      setReachByDate(syncDate);
      setReachByTime(syncTime);
    } else {
      if (reachByDate < toLocalDateString()) {
        setReachByDate(toLocalDateString());
        setReachByTime(getDefaultReachByTime());
      }
    }
  };

  const handleApplyReplayPreset = () => {
    setReplayDate(VERIFIED_REPLAY_DATE);
    setReplayTime(VERIFIED_REPLAY_TIME);
    const { reachByDate: syncDate, reachByTime: syncTime } = calculateReplayDeadline(
      VERIFIED_REPLAY_DATE,
      VERIFIED_REPLAY_TIME
    );
    setReachByDate(syncDate);
    setReachByTime(syncTime);
    setError(null);
  };

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (!fromStop.trim() || !toStop.trim()) {
      setError({
        title: 'Invalid Journey Stops',
        message: 'Please enter both an origin stop and a destination stop.',
        errorType: 'MISSING_STOPS',
      });
      return;
    }

    let requestParams: JourneyRecommendRequest;

    if (telemetryMode === 'replay') {
      const parsedPred = parseDateTimeToUnix(replayDate, replayTime);
      if (parsedPred.error || parsedPred.unixSeconds == null || !parsedPred.targetDate) {
        setError({
          title: 'Invalid Replay Timestamp',
          message: parsedPred.error || 'Please provide a valid historical observation date and time.',
          errorType: 'INVALID_PREDICTION_TIME',
        });
        return;
      }

      const parsedDeadline = combineDateAndTimeToUnix(
        reachByDate,
        reachByTime,
        parsedPred.targetDate,
        'historical observation time'
      );
      if (parsedDeadline.error || parsedDeadline.unixSeconds == null) {
        setError({
          title: 'Invalid Arrival Deadline',
          message: parsedDeadline.error || 'Please provide a valid reach-by date and time after the observation time.',
          errorType: 'INVALID_DEADLINE',
        });
        return;
      }

      if (parsedDeadline.unixSeconds <= parsedPred.unixSeconds) {
        setError({
          title: 'Invalid Arrival Deadline',
          message: 'The reach-by deadline must be strictly after the historical observation time.',
          errorType: 'INVALID_DEADLINE',
        });
        return;
      }

      requestParams = {
        from: fromStopId || fromStop.trim(),
        to: toStopId || toStop.trim(),
        reach_by: parsedDeadline.unixSeconds,
        mode: 'replay',
        prediction_time: parsedPred.unixSeconds,
      };
    } else {
      const parsed = combineDateAndTimeToUnix(reachByDate, reachByTime, new Date());
      if (parsed.error || !parsed.unixSeconds) {
        setError({
          title: 'Invalid Arrival Deadline',
          message: parsed.error || 'Please provide a valid future reach-by date and time.',
          errorType: 'INVALID_DEADLINE',
        });
        return;
      }

      requestParams = {
        from: fromStopId || fromStop.trim(),
        to: toStopId || toStop.trim(),
        reach_by: parsed.unixSeconds,
        mode: 'live',
      };
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedIdOverride(null);

    try {
      const response = await fetchJourneyRecommendation(requestParams);
      setResult(response);
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      const errType = apiErr?.errorType;
      const rawMsg =
        apiErr?.message ||
        (err instanceof Error
          ? err.message
          : 'Unable to plan journey. Please verify your connection.');

      let title = 'Unable to plan journey';
      switch (errType) {
        case 'MISSING_PREDICTION_TIME':
        case 'INVALID_PREDICTION_TIME':
          title = 'Invalid Replay Timestamp';
          break;
        case 'FUTURE_PREDICTION_TIME':
          title = 'Future Timestamp Rejected';
          break;
        case 'IN_SAMPLE_REPLAY_FORBIDDEN':
          title = 'In-Sample Historical Replay Restricted';
          break;
        case 'NO_HISTORICAL_SNAPSHOT':
          title = 'No Historical Snapshot Found';
          break;
        case 'ARCHIVE_GAP_EXCEEDED':
          title = 'Archive Gap Exceeded';
          break;
        case 'ARCHIVE_DATA_UNAVAILABLE':
          title = 'Archive Telemetry Unavailable';
          break;
        case 'STALE_TELEMETRY_FEED':
          title = 'Stale Live Telemetry Feed';
          break;
        case 'DATASET_UNAVAILABLE':
          title = 'Telemetry Feed Unavailable';
          break;
        case 'INVALID_DEADLINE':
          title = 'Invalid Arrival Deadline';
          break;
        case 'NO_DIRECT_ROUTE':
          title = 'No Direct Route Found';
          break;
        case 'IDENTICAL_STOPS':
          title = 'Invalid Journey Stops';
          break;
      }

      setError({
        title,
        message: rawMsg,
        errorType: errType,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSwapStops = () => {
    const tempText = fromStop;
    const tempId = fromStopId;
    setFromStop(toStop);
    setFromStopId(toStopId);
    setToStop(tempText);
    setToStopId(tempId);
    setResult(null);
    setError(null);
    setSelectedIdOverride(null);
  };

  // Find currently selected candidate bus
  const activeCandidate: CandidateBus | null = useMemo(() => {
    if (!result) return null;
    if (result.recommended_candidate?.vehicle_id === selectedVehicleId) {
      return result.recommended_candidate;
    }
    const foundAlt = result.alternative_candidates?.find(
      (c) => c.vehicle_id === selectedVehicleId
    );
    if (foundAlt) return foundAlt;
    const foundUnrel = result.unreliable_candidates?.find(
      (c) => c.vehicle_id === selectedVehicleId
    );
    if (foundUnrel) return foundUnrel;
    return result.recommended_candidate || null;
  }, [result, selectedVehicleId]);

  const rec = result?.recommended_candidate;

  // Extract coordinate geometry from activeCandidate
  const originCoords = useMemo<[number, number] | null>(() => {
    if (
      activeCandidate?.pickup?.latitude != null &&
      activeCandidate?.pickup?.longitude != null &&
      !isNaN(activeCandidate.pickup.latitude) &&
      !isNaN(activeCandidate.pickup.longitude)
    ) {
      return [activeCandidate.pickup.latitude, activeCandidate.pickup.longitude];
    }
    return null;
  }, [activeCandidate]);

  const destinationCoords = useMemo<[number, number] | null>(() => {
    if (
      activeCandidate?.destination?.latitude != null &&
      activeCandidate?.destination?.longitude != null &&
      !isNaN(activeCandidate.destination.latitude) &&
      !isNaN(activeCandidate.destination.longitude)
    ) {
      return [activeCandidate.destination.latitude, activeCandidate.destination.longitude];
    }
    return null;
  }, [activeCandidate]);

  const routeGeometry = useMemo<[number, number][] | null>(() => {
    if (
      activeCandidate?.route_path &&
      Array.isArray(activeCandidate.route_path) &&
      activeCandidate.route_path.length > 0
    ) {
      return activeCandidate.route_path;
    }
    return null;
  }, [activeCandidate]);

  // Shared map element props
  const mapProps = {
    originName: activeCandidate?.pickup?.stop_name || (result ? result.query.origin_stop : fromStop),
    destinationName: activeCandidate?.destination?.stop_name || (result ? result.query.destination_stop : toStop),
    originCoords,
    destinationCoords,
    activeCandidate,
    routeGeometry,
    hasSearched: !!result,
  };

  return (
    <div className="planner-root">
      {/* Slim Top Bar */}
      <TopBar
        telemetryMode={telemetryMode}
        onModeChange={handleModeChange}
        health={health}
        healthError={healthError}
      />

      {/* Main Viewport Area */}
      <main className="planner-viewport">
        <div className="planner-container">
          {/* LEFT Column: Planner Form + Results (Internally scrollable on desktop) */}
          <div className="planner-column">
            {/* 1. Journey Planner Form */}
            <PlannerForm
              fromStop={fromStop}
              setFromStop={setFromStop}
              fromStopId={fromStopId}
              setFromStopId={setFromStopId}
              toStop={toStop}
              setToStop={setToStop}
              toStopId={toStopId}
              setToStopId={setToStopId}
              reachByDate={reachByDate}
              setReachByDate={setReachByDate}
              reachByTime={reachByTime}
              setReachByTime={setReachByTime}
              humanDeadlinePreview={humanDeadlinePreview}
              loading={loading}
              onSearch={handleSearch}
              onSwap={handleSwapStops}
              telemetryMode={telemetryMode}
              replayDate={replayDate}
              setReplayDate={setReplayDate}
              replayTime={replayTime}
              setReplayTime={setReplayTime}
              onApplyReplayPreset={handleApplyReplayPreset}
              resolvedSnapshotPath={result?.query?.snapshot_path}
              resolvedSnapshotAgeSeconds={result?.query?.snapshot_age_seconds}
              replayTimestampContext={result?.query?.prediction_time_formatted}
            />

            {/* Error Notification */}
            {error && (
              <div className="action-notification error-banner" role="alert">
                <div className="notification-icon" aria-hidden="true">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                </div>
                <div className="notification-text">
                  <strong>{error.title}</strong>
                  <p>{error.message}</p>
                  {error.errorType && (
                    <span style={{ fontSize: '0.72rem', opacity: 0.85, marginTop: '2px', display: 'block' }}>
                      Code: {error.errorType}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Loading State */}
            {loading && (
              <div className="loading-state-card" role="status" aria-live="polite">
                <div className="loading-spinner-ring" aria-hidden="true" />
                <div className="loading-copy">
                  <h3 className="loading-title">Evaluating Corridor Telemetry</h3>
                  <p className="loading-subtitle">
                    Projecting vehicle positions and computing arrival probabilities...
                  </p>
                </div>
              </div>
            )}

            {/* Non-Desktop Map (Tablet & Mobile: positioned after planner card if no results) */}
            {!isDesktop && !result && !loading && (
              <div className="mobile-map-slot">
                <MapPanel {...mapProps} />
              </div>
            )}

            {/* Results Presentation */}
            {result && (
              <div className="results-container" aria-live="polite">
                {/* Boundary State Notices */}
                {result.system_state === 'NO_DIRECT_ROUTE' && (
                  <div className="status-notice-card" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">No Direct Route Found</h3>
                      <p className="notice-desc">
                        No direct bus route was found connecting <strong>{result.query.origin_stop}</strong> and{' '}
                        <strong>{result.query.destination_stop}</strong> in the network.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {result.system_state === 'NO_CANDIDATE_BUS' && (
                  <div className="status-notice-card" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">No Buses Currently Upstream</h3>
                      <p className="notice-desc">
                        Direct routes connect <strong>{result.query.origin_stop}</strong> to{' '}
                        <strong>{result.query.destination_stop}</strong>, but there are no active buses currently traveling upstream between the depot and your pickup stop.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {result.system_state === 'NO_RELIABLE_JOURNEY' && (
                  <div className="status-notice-card status-notice-warning" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                        <line x1="12" y1="9" x2="12" y2="13" />
                        <line x1="12" y1="17" x2="12.01" y2="17" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">Deadline Cannot Be Reliably Met</h3>
                      <p className="notice-desc">
                        None of the active buses are estimated to reach{' '}
                        <strong>{result.query.destination_stop}</strong> before your deadline.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {result.system_state === 'INSUFFICIENT_DATA' && (
                  <div className="status-notice-card" role="status">
                    <div className="notice-icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="16" x2="12" y2="12" />
                        <line x1="12" y1="8" x2="12.01" y2="8" />
                      </svg>
                    </div>
                    <div className="notice-content">
                      <h3 className="notice-title">Insufficient Historical Evidence</h3>
                      <p className="notice-desc">
                        Empirical segment observations for this corridor are insufficient to compute arrival probabilities defensibly.
                      </p>
                      <p className="direct-only-note">Showing direct buses only. Transfers are not supported yet.</p>
                    </div>
                  </div>
                )}

                {/* 2. Results Header (Title + Direct-Only Note) */}
                {rec && (
                  <div className="results-header-block">
                    <h2 className="results-header-title">Recommended journey</h2>
                    <p className="direct-only-note">
                      Showing direct buses only. Transfers are not supported yet.
                    </p>
                  </div>
                )}

                {/* 3. Recommended Journey Card */}
                {rec && (
                  <RecommendationCard
                    candidate={rec}
                    response={result}
                    isSelected={selectedVehicleId === rec.vehicle_id}
                    onSelect={() => setSelectedIdOverride(rec.vehicle_id)}
                  />
                )}

                {/* Non-Desktop Map (Tablet & Mobile: positioned right after recommended card) */}
                {!isDesktop && (
                  <div className="mobile-map-slot">
                    <MapPanel {...mapProps} />
                  </div>
                )}

                {/* 4. Collapsible Technical Disclosure */}
                {rec && (
                  <EvidenceDisclosure
                    candidate={rec}
                    comparison={result.comparison_with_fastest_eta}
                    query={result.query}
                    provenance={result.provenance}
                    telemetryDiagnostics={result.telemetry_diagnostics}
                  />
                )}

                {/* 5. Alternatives List */}
                <AlternativesList
                  alternatives={result.alternative_candidates}
                  unreliableCandidates={result.unreliable_candidates}
                  selectedVehicleId={selectedVehicleId}
                  onSelectCandidate={(cand) => setSelectedIdOverride(cand.vehicle_id)}
                />
              </div>
            )}
          </div>

          {/* RIGHT Column: MapPanel (Desktop >= 1024px: fills 100% height, zero overlay) */}
          {isDesktop && (
            <div className="map-column">
              <MapPanel {...mapProps} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default App;
