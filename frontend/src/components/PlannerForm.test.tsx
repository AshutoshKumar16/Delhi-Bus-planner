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
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 9, 8, 0, 0));
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
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

  // -------------------------------------------------------------------------
  // 6. Displays inline validation alert when a past deadline is selected
  // -------------------------------------------------------------------------
  it('displays inline validation alert when a past deadline is selected in live mode', () => {
    // Current simulated time: 2026-11-09 08:00:00
    // Selected deadline: 2026-11-09 07:00 (1 hour in the past)
    render(
      <PlannerForm
        fromStop="Mahindra Park"
        setFromStop={() => {}}
        toStop="Azadpur"
        setToStop={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="07:00"
        setReachByTime={() => {}}
        humanDeadlinePreview="Today · 7:00 AM"
        loading={false}
        onSearch={() => {}}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    const alertEl = screen.getByRole('alert');
    expect(alertEl).toBeInTheDocument();
    expect(alertEl.textContent).toMatch(/already passed/i);
  });

  // -------------------------------------------------------------------------
  // 7. Disables submit button and prevents submission when deadline is invalid
  // -------------------------------------------------------------------------
  it('disables submit button and prevents onSearch call when deadline is in the past', async () => {
    const onSearchMock = vi.fn();

    render(
      <PlannerForm
        fromStop="Mahindra Park"
        setFromStop={() => {}}
        toStop="Azadpur"
        setToStop={() => {}}
        reachByDate="2026-11-09"
        setReachByDate={() => {}}
        reachByTime="07:00"
        setReachByTime={() => {}}
        humanDeadlinePreview="Today · 7:00 AM"
        loading={false}
        onSearch={onSearchMock}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    const submitBtn = screen.getByRole('button', { name: /find best routes/i });
    expect(submitBtn).toBeDisabled();

    // Clicking the disabled button should not trigger onSearch
    await act(async () => {
      await userEvent.click(submitBtn);
    });

    expect(onSearchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 8. Selecting a future deadline clears inline error and enables submission
  // -------------------------------------------------------------------------
  it('clears error and allows search submission when a future deadline is selected', async () => {
    const onSearchMock = vi.fn();

    // Tomorrow at 15:00 is strictly in the future
    render(
      <PlannerForm
        fromStop="Mahindra Park"
        setFromStop={() => {}}
        toStop="Azadpur"
        setToStop={() => {}}
        reachByDate="2026-11-10"
        setReachByDate={() => {}}
        reachByTime="15:00"
        setReachByTime={() => {}}
        humanDeadlinePreview="Tomorrow · 3:00 PM"
        loading={false}
        onSearch={onSearchMock}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // No error alert should be present
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const submitBtn = screen.getByRole('button', { name: /find best routes/i });
    expect(submitBtn).not.toBeDisabled();

    await act(async () => {
      await userEvent.click(submitBtn);
    });

    expect(onSearchMock).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 9. Replay mode blocks submission when deadline is before observation time
  // -------------------------------------------------------------------------
  it('blocks submission in replay mode when deadline is prior to observation time', async () => {
    const onSearchMock = vi.fn();

    render(
      <PlannerForm
        fromStop="Mahindra Park"
        setFromStop={() => {}}
        toStop="Azadpur"
        setToStop={() => {}}
        reachByDate="2026-10-06"
        setReachByDate={() => {}}
        reachByTime="06:30:00" // Before 07:05:02 observation time
        setReachByTime={() => {}}
        humanDeadlinePreview={null}
        loading={false}
        onSearch={onSearchMock}
        onSwap={() => {}}
        telemetryMode="replay"
        replayDate="2026-10-06"
        replayTime="07:05:02"
      />
    );

    const alertEl = screen.getByRole('alert');
    expect(alertEl).toBeInTheDocument();
    expect(alertEl.textContent).toMatch(/must be after the historical observation time/i);

    const submitBtn = screen.getByRole('button', { name: /find best routes/i });
    expect(submitBtn).toBeDisabled();

    await act(async () => {
      await userEvent.click(submitBtn);
    });

    expect(onSearchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 10. Real bug reproduction at 11:42 PM: today is blocked, tomorrow is allowed
  // -------------------------------------------------------------------------
  it('reproduces 11:42 PM bug: blocks today at 00:45, permits tomorrow at 00:45', async () => {
    // Set system time to 11 Nov 2026 at 23:42 IST
    vi.setSystemTime(new Date(2026, 10, 11, 23, 42, 0));
    const onSearchMock = vi.fn();

    // 10a. Bugged state: Today (2026-11-11) + 00:45 (in the past)
    const { rerender } = render(
      <PlannerForm
        fromStop="Mahindra Park"
        setFromStop={() => {}}
        toStop="Azadpur"
        setToStop={() => {}}
        reachByDate="2026-11-11"
        setReachByDate={() => {}}
        reachByTime="00:45"
        setReachByTime={() => {}}
        humanDeadlinePreview="Today · 12:45 AM"
        loading={false}
        onSearch={onSearchMock}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Must show alert and disable submit
    const alertEl = screen.getByRole('alert');
    expect(alertEl).toBeInTheDocument();
    expect(alertEl.textContent).toMatch(/already passed/i);

    const submitBtn = screen.getByRole('button', { name: /find best routes/i });
    expect(submitBtn).toBeDisabled();

    await act(async () => {
      await userEvent.click(submitBtn);
    });
    expect(onSearchMock).not.toHaveBeenCalled();

    // 10b. Fixed state: Tomorrow (2026-11-12) + 00:45 (in the future)
    rerender(
      <PlannerForm
        fromStop="Mahindra Park"
        setFromStop={() => {}}
        toStop="Azadpur"
        setToStop={() => {}}
        reachByDate="2026-11-12"
        setReachByDate={() => {}}
        reachByTime="00:45"
        setReachByTime={() => {}}
        humanDeadlinePreview="Tomorrow · 12:45 AM"
        loading={false}
        onSearch={onSearchMock}
        onSwap={() => {}}
        telemetryMode="live"
      />
    );

    // Alert must clear and re-queried submit button must be enabled
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const updatedSubmitBtn = screen.getByRole('button', { name: /find best routes/i });
    expect(updatedSubmitBtn).not.toBeDisabled();

    await act(async () => {
      await userEvent.click(updatedSubmitBtn);
    });
    expect(onSearchMock).toHaveBeenCalledTimes(1);
  });
});
