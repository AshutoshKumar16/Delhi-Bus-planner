/**
 * Focused tests for the stale-destinations bug fix in PlannerForm.
 *
 * Scenarios covered:
 * 1. Changing origin clears old suggestions immediately.
 * 2. A failed / aborted request cannot restore stale destinations.
 * 3. Rapid origin changes cannot display results from an older request.
 * 4. Swap refreshes destinations for the new origin.
 * 5. Successful requests display only the correct origin's destinations.
 */

import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';

import { PlannerForm } from './PlannerForm';
import * as api from '../api';
import type { ReachableDestinationsResponse } from '../types';

// ---------------------------------------------------------------------------
// Helpers / constants
// ---------------------------------------------------------------------------

const AZADPUR_ID = 'STOP_AZP';
const KASHMERE_ID = 'STOP_KGT';

function makeDestResponse(stopId: string, name: string): ReachableDestinationsResponse {
  return {
    status: 'success',
    origin: { stop_id: stopId, display_name: name, lat: 28.7, lon: 77.1 },
    connectivity_type: 'structural_network',
    disclosure: '',
    results_count: 1,
    limit: 50,
    destinations: [
      {
        stop_id: `${stopId}_DST`,
        display_name: `${name} Downstream`,
        name_normalized: `${name.toLowerCase()} downstream`,
        serving_direction_count: 2,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PlannerForm – stale downstream destinations fix', () => {
  // -------------------------------------------------------------------------
  // 1. Changing origin clears old suggestions immediately
  // -------------------------------------------------------------------------
  it('changing origin from Azadpur to Kashmere Gate clears old suggestions', async () => {
    // First fetch resolves immediately with Azadpur destinations.
    const fetchMock = vi
      .spyOn(api, 'fetchReachableDestinations')
      .mockResolvedValueOnce(makeDestResponse(AZADPUR_ID, 'Azadpur'))
      .mockResolvedValueOnce(makeDestResponse(KASHMERE_ID, 'Kashmere Gate'));

    const { rerender } = render(
      <PlannerForm
        fromStop="Azadpur"
        setFromStop={() => {}}
        fromStopId={AZADPUR_ID}
        setFromStopId={() => {}}
        toStop=""
        setToStop={() => {}}
        toStopId={null}
        setToStopId={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="09:00"
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Open destination dropdown and wait for Azadpur destinations to appear
    const toInput = screen.getByRole('combobox', { name: /destination/i });
    await act(async () => {
      await userEvent.click(toInput);
    });

    await waitFor(() => {
      expect(screen.queryByText('Azadpur Downstream')).toBeInTheDocument();
    });

    // Now change origin to Kashmere Gate
    rerender(
      <PlannerForm
        fromStop="Kashmere Gate"
        setFromStop={() => {}}
        fromStopId={KASHMERE_ID}
        setFromStopId={() => {}}
        toStop=""
        setToStop={() => {}}
        toStopId={null}
        setToStopId={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="09:00"
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Azadpur destinations must disappear immediately (before the new fetch resolves)
    expect(screen.queryByText('Azadpur Downstream')).not.toBeInTheDocument();

    // Kashmere Gate destinations should eventually appear
    await waitFor(() => {
      expect(screen.queryByText('Kashmere Gate Downstream')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 2. A failed or aborted request cannot restore stale destinations
  // -------------------------------------------------------------------------
  it('a failed request does not restore stale destinations', async () => {
    // First fetch succeeds (loads Azadpur destinations)
    vi.spyOn(api, 'fetchReachableDestinations')
      .mockResolvedValueOnce(makeDestResponse(AZADPUR_ID, 'Azadpur'))
      // Second fetch (Kashmere Gate) fails
      .mockRejectedValueOnce(new Error('Network error'));

    const { rerender } = render(
      <PlannerForm
        fromStop="Azadpur"
        setFromStop={() => {}}
        fromStopId={AZADPUR_ID}
        setFromStopId={() => {}}
        toStop=""
        setToStop={() => {}}
        toStopId={null}
        setToStopId={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="09:00"
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Open destination dropdown and wait for Azadpur destinations
    const toInput = screen.getByRole('combobox', { name: /destination/i });
    await act(async () => {
      await userEvent.click(toInput);
    });
    await waitFor(() => {
      expect(screen.queryByText('Azadpur Downstream')).toBeInTheDocument();
    });

    // Switch to Kashmere Gate origin (fetch will fail)
    rerender(
      <PlannerForm
        fromStop="Kashmere Gate"
        setFromStop={() => {}}
        fromStopId={KASHMERE_ID}
        setFromStopId={() => {}}
        toStop=""
        setToStop={() => {}}
        toStopId={null}
        setToStopId={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="09:00"
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Old destinations cleared immediately
    expect(screen.queryByText('Azadpur Downstream')).not.toBeInTheDocument();

    // After the failed fetch, Azadpur destinations must NOT reappear
    await waitFor(() => {
      expect(screen.queryByText('Azadpur Downstream')).not.toBeInTheDocument();
    });
    expect(screen.queryByText('Kashmere Gate Downstream')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 3. Rapid origin changes cannot display results from an older request
  // -------------------------------------------------------------------------
  it('rapid origin changes do not show results from an older (slower) request', async () => {
    let resolveAzadpur!: (val: ReachableDestinationsResponse) => void;
    let resolveKashmere!: (val: ReachableDestinationsResponse) => void;

    const azadpurPromise = new Promise<ReachableDestinationsResponse>((res) => {
      resolveAzadpur = res;
    });
    const kashmerePromise = new Promise<ReachableDestinationsResponse>((res) => {
      resolveKashmere = res;
    });

    vi.spyOn(api, 'fetchReachableDestinations')
      .mockReturnValueOnce(azadpurPromise)   // first (older) request
      .mockReturnValueOnce(kashmerePromise); // second (newer) request

    const { rerender } = render(
      <PlannerForm
        fromStop="Azadpur"
        setFromStop={() => {}}
        fromStopId={AZADPUR_ID}
        setFromStopId={() => {}}
        toStop=""
        setToStop={() => {}}
        toStopId={null}
        setToStopId={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="09:00"
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Immediately switch to Kashmere Gate before first fetch resolves
    rerender(
      <PlannerForm
        fromStop="Kashmere Gate"
        setFromStop={() => {}}
        fromStopId={KASHMERE_ID}
        setFromStopId={() => {}}
        toStop=""
        setToStop={() => {}}
        toStopId={null}
        setToStopId={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="09:00"
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Resolve Kashmere Gate (newer) first
    await act(async () => {
      resolveKashmere(makeDestResponse(KASHMERE_ID, 'Kashmere Gate'));
    });

    // Open destination dropdown
    const toInput = screen.getByRole('combobox', { name: /destination/i });
    await act(async () => {
      await userEvent.click(toInput);
    });

    await waitFor(() => {
      expect(screen.queryByText('Kashmere Gate Downstream')).toBeInTheDocument();
    });

    // Now resolve the older Azadpur fetch (simulates network race)
    await act(async () => {
      resolveAzadpur(makeDestResponse(AZADPUR_ID, 'Azadpur'));
    });

    // Old (Azadpur) results must NOT appear after Kashmere Gate is active
    expect(screen.queryByText('Azadpur Downstream')).not.toBeInTheDocument();
    expect(screen.queryByText('Kashmere Gate Downstream')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 4. Swap refreshes destinations for the new origin
  // -------------------------------------------------------------------------
  it('swap refreshes destinations for the new origin', async () => {
    const fetchMock = vi
      .spyOn(api, 'fetchReachableDestinations')
      // Initial render: fromStopId = AZADPUR_ID
      .mockResolvedValueOnce(makeDestResponse(AZADPUR_ID, 'Azadpur'))
      // After swap: fromStopId = KASHMERE_ID
      .mockResolvedValueOnce(makeDestResponse(KASHMERE_ID, 'Kashmere Gate'));

    // SwapWrapper keeps toStop empty so the destinations panel is always
    // shown (not search-results mode). The swap callback updates the origin
    // stop ID which triggers the fix under test.
    function SwapWrapper() {
      const [fromStop, setFromStop] = useState('Azadpur');
      const [fromStopId, setFromStopId] = useState<string | null>(AZADPUR_ID);
      const [reachByDate] = useState('2026-11-09');
      const [reachByTime] = useState('09:00');

      const onSwap = () => {
        // Simulate swap: new origin becomes Kashmere Gate
        setFromStop('Kashmere Gate');
        setFromStopId(KASHMERE_ID);
      };

      return (
        <PlannerForm
          fromStop={fromStop}
          setFromStop={setFromStop}
          fromStopId={fromStopId}
          setFromStopId={setFromStopId}
          toStop=""
          setToStop={() => {}}
          toStopId={null}
          setToStopId={() => {}}
          reachByDate={reachByDate}
          setReachByDate={() => {}}
          reachByTime={reachByTime}
          setReachByTime={() => {}}
          humanDeadlinePreview={null}
          loading={false}
          onSearch={() => {}}
          onSwap={onSwap}
          telemetryMode="live"
        />
      );
    }

    render(<SwapWrapper />);

    // Open destination dropdown and wait for Azadpur destinations to appear
    const toInput = screen.getByRole('combobox', { name: /destination/i });
    await act(async () => {
      await userEvent.click(toInput);
    });
    await waitFor(() => {
      expect(screen.queryByText('Azadpur Downstream')).toBeInTheDocument();
    });

    // Click the swap button – triggers origin change to Kashmere Gate
    const swapButton = screen.getByRole('button', { name: /swap origin and destination/i });
    await act(async () => {
      await userEvent.click(swapButton);
    });

    // Azadpur destinations must clear immediately (synchronous reset in effect)
    expect(screen.queryByText('Azadpur Downstream')).not.toBeInTheDocument();

    // Re-open the destination dropdown (swap closes it via handleSwapWithDropdownClose)
    await act(async () => {
      await userEvent.click(toInput);
    });

    // Kashmere Gate destinations should appear after the new fetch resolves
    await waitFor(() => {
      expect(screen.queryByText('Kashmere Gate Downstream')).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, AZADPUR_ID, 50, expect.any(AbortSignal));
    expect(fetchMock).toHaveBeenNthCalledWith(2, KASHMERE_ID, 50, expect.any(AbortSignal));
  });

  // -------------------------------------------------------------------------
  // 5. Successful requests display only the correct origin's destinations
  // -------------------------------------------------------------------------
  it('successful fetch displays only the correct origin destinations', async () => {
    vi.spyOn(api, 'fetchReachableDestinations').mockResolvedValue(
      makeDestResponse(KASHMERE_ID, 'Kashmere Gate')
    );

    render(
      <PlannerForm
        fromStop="Kashmere Gate"
        setFromStop={() => {}}
        fromStopId={KASHMERE_ID}
        setFromStopId={() => {}}
        toStop=""
        setToStop={() => {}}
        toStopId={null}
        setToStopId={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="09:00"
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Open destination dropdown
    const toInput = screen.getByRole('combobox', { name: /destination/i });
    await act(async () => {
      await userEvent.click(toInput);
    });

    await waitFor(() => {
      expect(screen.queryByText('Kashmere Gate Downstream')).toBeInTheDocument();
    });

    // No Azadpur data should ever appear
    expect(screen.queryByText('Azadpur Downstream')).not.toBeInTheDocument();
  });
});
