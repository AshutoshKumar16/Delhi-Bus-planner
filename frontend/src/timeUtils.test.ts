import { describe, it, expect } from 'vitest';
import {
  getDefaultReachByDateAndTime,
  getDefaultReachByTime,
  combineDateAndTimeToUnix,
  parseDateTimeToUnix,
} from './timeUtils';

describe('timeUtils – deadline initialization and midnight rollover', () => {
  describe('getDefaultReachByDateAndTime', () => {
    it('returns today 11:00 AM when current time is early morning (< 10 AM)', () => {
      const earlyMorning = new Date(2026, 10, 11, 8, 30, 0); // 11 Nov 2026, 08:30
      const res = getDefaultReachByDateAndTime(earlyMorning);
      expect(res.reachByDate).toBe('2026-11-11');
      expect(res.reachByTime).toBe('11:00');
    });

    it('returns today 11:00 AM at 09:59 AM boundary', () => {
      const justBeforeTen = new Date(2026, 10, 11, 9, 59, 0);
      const res = getDefaultReachByDateAndTime(justBeforeTen);
      expect(res.reachByDate).toBe('2026-11-11');
      expect(res.reachByTime).toBe('11:00');
    });

    it('returns today and +1 hour rounded up to next 15 minutes during daytime', () => {
      const afternoon = new Date(2026, 10, 11, 14, 10, 0); // 14:10 -> +1hr = 15:10 -> 15:15
      const res = getDefaultReachByDateAndTime(afternoon);
      expect(res.reachByDate).toBe('2026-11-11');
      expect(res.reachByTime).toBe('15:15');
    });

    it('handles hour increment when minute rounding reaches 60', () => {
      const lateAfternoon = new Date(2026, 10, 11, 14, 50, 0); // 14:50 -> +1hr = 15:50 -> round 50 to 60 -> 16:00
      const res = getDefaultReachByDateAndTime(lateAfternoon);
      expect(res.reachByDate).toBe('2026-11-11');
      expect(res.reachByTime).toBe('16:00');
    });

    it('handles exact 15-minute intervals without skipping ahead', () => {
      const onTheQuarter = new Date(2026, 10, 11, 14, 15, 0); // 14:15 -> +1hr = 15:15 -> 15:15
      const res = getDefaultReachByDateAndTime(onTheQuarter);
      expect(res.reachByDate).toBe('2026-11-11');
      expect(res.reachByTime).toBe('15:15');
    });

    it('handles 23:00 boundary correctly (rolls over to 00:00 tomorrow)', () => {
      const elevenPm = new Date(2026, 10, 11, 23, 0, 0); // 23:00 -> +1hr = 00:00 tomorrow
      const res = getDefaultReachByDateAndTime(elevenPm);
      expect(res.reachByDate).toBe('2026-11-12');
      expect(res.reachByTime).toBe('00:00');
    });

    it('reproduces real bug scenario at 11:42 PM on 11 Nov: rolls over to 12 Nov at 00:45', () => {
      const realBugMoment = new Date(2026, 10, 11, 23, 42, 0); // 11:42 PM
      const res = getDefaultReachByDateAndTime(realBugMoment);
      expect(res.reachByDate).toBe('2026-11-12');
      expect(res.reachByTime).toBe('00:45');

      // Crucial invariant: combined date-time must be strictly in the future relative to the current time
      const combined = combineDateAndTimeToUnix(res.reachByDate, res.reachByTime, realBugMoment);
      expect(combined.error).toBeUndefined();
      expect(combined.unixSeconds).toBeGreaterThan(Math.floor(realBugMoment.getTime() / 1000));
    });

    it('rolls over month boundary cleanly on 31 Oct at 23:50 -> 01 Nov at 01:00', () => {
      const monthEnd = new Date(2026, 9, 31, 23, 50, 0);
      const res = getDefaultReachByDateAndTime(monthEnd);
      expect(res.reachByDate).toBe('2026-11-01');
      expect(res.reachByTime).toBe('01:00');
    });

    it('rolls over year boundary cleanly on 31 Dec at 23:45 -> 01 Jan 2027 at 00:45', () => {
      const yearEnd = new Date(2026, 11, 31, 23, 45, 0);
      const res = getDefaultReachByDateAndTime(yearEnd);
      expect(res.reachByDate).toBe('2027-01-01');
      expect(res.reachByTime).toBe('00:45');
    });
  });

  describe('getDefaultReachByTime', () => {
    it('preserves backward compatibility by returning identical time string', () => {
      const realBugMoment = new Date(2026, 10, 11, 23, 42, 0);
      expect(getDefaultReachByTime(realBugMoment)).toBe('00:45');
    });
  });

  describe('combineDateAndTimeToUnix', () => {
    it('rejects past deadline on current day with descriptive error message', () => {
      const current = new Date(2026, 10, 11, 23, 42, 0);
      // User entered 00:45 on today's date (which passed 22h 57m ago)
      const res = combineDateAndTimeToUnix('2026-11-11', '00:45', current);
      expect(res.error).toBeDefined();
      expect(res.error).toMatch(/has already passed/i);
    });

    it('accepts future deadline on tomorrow date after midnight rollover', () => {
      const current = new Date(2026, 10, 11, 23, 42, 0);
      const res = combineDateAndTimeToUnix('2026-11-12', '00:45', current);
      expect(res.error).toBeUndefined();
      expect(res.unixSeconds).toBeDefined();
    });

    it('validates against historical observation time in replay mode', () => {
      const replayObs = parseDateTimeToUnix('2026-10-06', '07:05:02').targetDate!;
      // Deadline before observation time
      const resPast = combineDateAndTimeToUnix('2026-10-06', '06:30:00', replayObs, 'historical observation time');
      expect(resPast.error).toMatch(/must be after the historical observation time/i);

      // Deadline after observation time
      const resFuture = combineDateAndTimeToUnix('2026-10-06', '07:35:00', replayObs, 'historical observation time');
      expect(resFuture.error).toBeUndefined();
    });
  });
});
