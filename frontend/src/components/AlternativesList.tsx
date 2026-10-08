import React from 'react';
import type { CandidateBus } from '../types';
import { formatTimeTo12Hour } from '../timeUtils';

interface AlternativesListProps {
  alternatives: CandidateBus[];
  unreliableCandidates?: CandidateBus[];
  selectedVehicleId: string;
  onSelectCandidate: (candidate: CandidateBus) => void;
}

export const AlternativesList: React.FC<AlternativesListProps> = ({
  alternatives,
  unreliableCandidates,
  selectedVehicleId,
  onSelectCandidate,
}) => {
  if (
    (!alternatives || alternatives.length === 0) &&
    (!unreliableCandidates || unreliableCandidates.length === 0)
  ) {
    return null;
  }

  const renderCandidateCard = (c: CandidateBus, isUnreliable: boolean = false) => {
    const isSelected = selectedVehicleId === c.vehicle_id;
    const probPct = c.deadline_probability.probability_on_time_pct;
    const slack = c.deadline_probability.slack_minutes;

    const probClass = isUnreliable
      ? 'prob-alt-low'
      : probPct >= 80
      ? 'prob-alt-high'
      : probPct >= 50
      ? 'prob-alt-medium'
      : 'prob-alt-low';

    return (
      <button
        key={`${c.route_id}-${c.vehicle_id}`}
        type="button"
        className={`alt-card ${isSelected ? 'is-selected' : ''} ${isUnreliable ? 'is-late' : ''}`}
        onClick={() => onSelectCandidate(c)}
        aria-pressed={isSelected}
      >
        <div className="alt-card-header">
          <div className="alt-bus-badge">
            <span className="alt-bus-reg">{c.vehicle_id}</span>
            {c.route_id && <span className="alt-route-num">Route {c.route_id}</span>}
          </div>
          <span className={`alt-prob-badge ${probClass}`}>
            {probPct}% est. chance
          </span>
        </div>

        <div className="alt-card-stats">
          <div className="alt-stat">
            <span className="alt-stat-label">Arrives</span>
            <span className="alt-stat-val tabular">
              {formatTimeTo12Hour(c.destination.expected_arrival)}
            </span>
          </div>

          <div className="alt-stat">
            <span className="alt-stat-label">Pickup Wait</span>
            <span className="alt-stat-val tabular">
              ~{c.pickup.expected_wait_minutes} min
            </span>
          </div>

          <div className="alt-stat">
            <span className="alt-stat-label">Margin</span>
            <span
              className={`alt-stat-val tabular ${
                slack >= 0 ? 'margin-positive' : 'margin-negative'
              }`}
            >
              {slack > 0 ? `+${slack} min` : `${slack} min`}
            </span>
          </div>
        </div>
      </button>
    );
  };

  return (
    <div className="alternatives-wrapper">
      {alternatives && alternatives.length > 0 && (
        <section className="alternatives-section" aria-label="Other direct buses">
          <h4 className="alternatives-heading">Other Direct Options</h4>
          <div className="alternatives-list">
            {alternatives.map((alt) => renderCandidateCard(alt, false))}
          </div>
        </section>
      )}

      {unreliableCandidates && unreliableCandidates.length > 0 && (
        <section
          className="alternatives-section late-buses-section"
          aria-label="Buses projected to arrive after deadline"
        >
          <div className="late-section-header">
            <h4 className="alternatives-heading">Buses Arriving After Your Deadline</h4>
            <span className="late-section-caption">Would require later reach-by time</span>
          </div>
          <div className="alternatives-list">
            {unreliableCandidates.map((u) => renderCandidateCard(u, true))}
          </div>
        </section>
      )}
    </div>
  );
};
