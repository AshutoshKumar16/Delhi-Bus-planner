/**
 * Time utility functions for Delhi Bus Journey Planner
 * Supports native HTML5 date and time inputs.
 */

export interface CombineDateTimeResult {
  unixSeconds?: number;
  targetDate?: Date;
  error?: string;
  formattedHuman?: string;
}

/**
 * Indian Standard Time (IST) offset relative to UTC: +05:30 (+19,800 seconds).
 * Delhi Bus transit operations and schedules are anchored to IST.
 */
export const IST_OFFSET_SECONDS = 19800; // 5 hours 30 minutes in seconds
export const IST_OFFSET_MS = IST_OFFSET_SECONDS * 1000;

/**
 * Extracts year, month (0-indexed), day, hours, minutes, seconds of a Date in IST.
 */
export function getIstDateParts(d: Date): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const istDate = new Date(d.getTime() + IST_OFFSET_MS);
  return {
    year: istDate.getUTCFullYear(),
    month: istDate.getUTCMonth(),
    day: istDate.getUTCDate(),
    hours: istDate.getUTCHours(),
    minutes: istDate.getUTCMinutes(),
    seconds: istDate.getUTCSeconds(),
  };
}

/**
 * Returns today's local date formatted as "YYYY-MM-DD" for HTML5 date inputs.
 */
export function toLocalDateString(d: Date = new Date()): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Returns tomorrow's local date formatted as "YYYY-MM-DD" for HTML5 date inputs.
 */
export function toTomorrowDateString(d: Date = new Date()): string {
  const tomorrow = new Date(d);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return toLocalDateString(tomorrow);
}

export interface DefaultReachByDateAndTime {
  reachByDate: string;
  reachByTime: string;
}

/**
 * Computes default reach-by date and time atomically so that
 * when the computed time rolls over midnight (e.g. 23:42 + 1h -> 00:45),
 * reachByDate automatically advances to tomorrow, preventing past-deadline errors.
 */
export function getDefaultReachByDateAndTime(d: Date = new Date()): DefaultReachByDateAndTime {
  const hours = d.getHours();
  if (hours < 10) {
    return {
      reachByDate: toLocalDateString(d),
      reachByTime: '11:00',
    };
  }
  const future = new Date(d.getTime() + 60 * 60 * 1000);
  const roundedMins = Math.ceil(future.getMinutes() / 15) * 15;
  if (roundedMins === 60) {
    future.setHours(future.getHours() + 1);
    future.setMinutes(0);
  } else {
    future.setMinutes(roundedMins);
  }
  future.setSeconds(0, 0);
  return {
    reachByDate: toLocalDateString(future),
    reachByTime: `${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`,
  };
}

/**
 * Returns default reach-by time formatted as "HH:mm" for HTML5 time inputs.
 * Defaults to "11:00" for daytime planning, or 1 hour in future if already past 11:00.
 */
export function getDefaultReachByTime(d: Date = new Date()): string {
  return getDefaultReachByDateAndTime(d).reachByTime;
}

/**
 * Formats a backend timestamp (e.g. "2026-10-06 11:00:00 IST" or "11:00")
 * into human-friendly 12-hour clock format (e.g. "11:00 AM" or "7:05:02 AM").
 */
export function formatTimeTo12Hour(fullStr?: string): string {
  if (!fullStr) return '--:--';
  const match = fullStr.match(/(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|IST)?/i);
  if (match) {
    let hours = parseInt(match[2], 10);
    const minutes = match[3];
    const seconds = match[4];
    const modifier = match[5]?.toUpperCase();

    if (modifier === 'AM' || modifier === 'PM') {
      return seconds ? `${hours}:${minutes}:${seconds} ${modifier}` : `${hours}:${minutes} ${modifier}`;
    }

    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return seconds ? `${hours}:${minutes}:${seconds} ${ampm}` : `${hours}:${minutes} ${ampm}`;
  }
  return fullStr;
}

/**
 * Formats a Date object into human-friendly format like "Today · 11:00 AM" or "Tomorrow · 12:15 AM".
 */
export function formatHumanDeadline(
  targetDate: Date,
  referenceDate: Date = new Date()
): string {
  const targetParts = getIstDateParts(targetDate);
  const refParts = getIstDateParts(referenceDate);

  const time12h = formatTimeTo12Hour(
    `${targetParts.hours}:${String(targetParts.minutes).padStart(2, '0')}`
  );

  const refMidnight = Date.UTC(refParts.year, refParts.month, refParts.day);
  const targetMidnight = Date.UTC(targetParts.year, targetParts.month, targetParts.day);

  const diffDays = Math.round((targetMidnight - refMidnight) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) {
    return `Today · ${time12h}`;
  } else if (diffDays === 1) {
    return `Tomorrow · ${time12h}`;
  } else if (diffDays === -1) {
    return `Yesterday · ${time12h}`;
  } else {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${monthNames[targetParts.month]} ${targetParts.day} · ${time12h}`;
  }
}

/**
 * Formats a quick preview of reach-by date and time without throwing or impurity.
 */
export function getHumanDeadlinePreview(dateStr?: string, timeStr?: string): string | null {
  if (!dateStr || !timeStr) return null;
  const time12h = formatTimeTo12Hour(timeStr);
  const today = toLocalDateString();
  const tomorrow = toTomorrowDateString();

  if (dateStr === today) {
    return `Today · ${time12h}`;
  }
  if (dateStr === tomorrow) {
    return `Tomorrow · ${time12h}`;
  }

  const parts = dateStr.split('-');
  if (parts.length === 3) {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mIdx = parseInt(parts[1], 10) - 1;
    const day = parseInt(parts[2], 10);
    return `${monthNames[mIdx] || ''} ${day} · ${time12h}`;
  }

  return `${dateStr} · ${time12h}`;
}

/**
 * Formats an arrival window e.g. "12:34 – 12:38 AM" given prediction timestamp and 80% interval.
 */
export function formatArrivalWindow(
  predTsUnix?: number,
  intervalMinutes?: [number, number]
): string | null {
  if (!intervalMinutes || intervalMinutes.length < 2 || !predTsUnix) return null;
  const startTs = predTsUnix + Math.round(intervalMinutes[0] * 60);
  const endTs = predTsUnix + Math.round(intervalMinutes[1] * 60);
  const startIst = new Date(startTs * 1000 + IST_OFFSET_MS);
  const endIst = new Date(endTs * 1000 + IST_OFFSET_MS);
  const startStr = formatTimeTo12Hour(
    `${startIst.getUTCHours()}:${String(startIst.getUTCMinutes()).padStart(2, '0')}`
  );
  const endStr = formatTimeTo12Hour(
    `${endIst.getUTCHours()}:${String(endIst.getUTCMinutes()).padStart(2, '0')}`
  );
  return `${startStr} – ${endStr}`;
}

/**
 * Verified out-of-sample historical replay timestamp:
 * 1791250502 Unix seconds (2026-10-06 07:05:02 IST).
 */
export const VERIFIED_REPLAY_TIMESTAMP_UNIX = 1791250502;
export const VERIFIED_REPLAY_DATE = '2026-10-06';
export const VERIFIED_REPLAY_TIME = '07:05:02';

/**
 * Parses a date string ("YYYY-MM-DD") and time string ("HH:mm" or "HH:mm:ss")
 * into a local Date and Unix seconds in the local timezone (IST).
 * Does not perform relative future-deadline validation.
 */
export function parseDateTimeToUnix(
  dateStr: string,
  timeStr: string,
  referenceDateForFormatting: Date = new Date()
): CombineDateTimeResult {
  const trimmedDate = (dateStr || '').trim();
  const trimmedTime = (timeStr || '').trim();

  if (!trimmedDate) {
    return { error: 'Please select a date.' };
  }
  if (!trimmedTime) {
    return { error: 'Please select a time.' };
  }

  // Parse YYYY-MM-DD
  const dateParts = trimmedDate.split('-');
  if (dateParts.length !== 3) {
    return { error: 'Invalid date format. Please select a valid date (YYYY-MM-DD).' };
  }
  const year = parseInt(dateParts[0], 10);
  const month = parseInt(dateParts[1], 10) - 1;
  const day = parseInt(dateParts[2], 10);

  // Parse HH:mm or HH:mm:ss (HTML5 time format with step=1, or with 12h AM/PM modifier)
  const timeRegex = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([aApP][mM])?$/;
  const match = trimmedTime.match(timeRegex);
  if (!match) {
    return { error: 'Invalid time format. Please select a valid time (HH:mm or HH:mm:ss).' };
  }

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  const ampm = match[4]?.toUpperCase();

  if (minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return { error: 'Invalid minute or second value in time.' };
  }

  if (ampm) {
    if (hours < 1 || hours > 12) {
      return { error: 'Hours in 12-hour format must be between 1 and 12.' };
    }
    if (ampm === 'PM' && hours < 12) {
      hours += 12;
    } else if (ampm === 'AM' && hours === 12) {
      hours = 0;
    }
  } else {
    if (hours < 0 || hours > 23) {
      return { error: 'Hours in 24-hour format must be between 0 and 23.' };
    }
  }

  // Validate calendar date validity via Date.UTC to prevent month/day rollover (e.g. Feb 31)
  const utcCandidateMs = Date.UTC(year, month, day, hours, minutes, seconds, 0);
  if (isNaN(utcCandidateMs)) {
    return { error: 'Invalid date or time specified.' };
  }
  const checkDate = new Date(utcCandidateMs);
  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month ||
    checkDate.getUTCDate() !== day
  ) {
    return { error: 'Invalid date or time specified.' };
  }

  // Convert IST calendar instant into UTC epoch milliseconds
  // IST = UTC + 5h 30m => UTC epoch ms = Date.UTC(year, month, day, hours, minutes, seconds) - 19,800,000
  const epochMs = utcCandidateMs - IST_OFFSET_MS;
  const targetDate = new Date(epochMs);
  const humanStr = formatHumanDeadline(targetDate, referenceDateForFormatting);

  return {
    unixSeconds: Math.floor(epochMs / 1000),
    targetDate,
    formattedHuman: humanStr,
  };
}

/**
 * Combines date string ("YYYY-MM-DD") and time string ("HH:mm") into a local Date,
 * validates against past deadlines relative to minReferenceDate, and converts to Unix seconds.
 */
export function combineDateAndTimeToUnix(
  dateStr: string,
  timeStr: string,
  minReferenceDate: Date = new Date(),
  minReferenceLabel?: string
): CombineDateTimeResult {
  const parsed = parseDateTimeToUnix(dateStr, timeStr, minReferenceDate);
  if (parsed.error || !parsed.targetDate || parsed.unixSeconds == null) {
    return { error: parsed.error || 'Please provide a valid reach-by date and time.' };
  }

  const targetDate = parsed.targetDate;
  const humanStr = parsed.formattedHuman || formatHumanDeadline(targetDate, minReferenceDate);

  // Validate that deadline is strictly in the future relative to minReferenceDate
  if (targetDate.getTime() <= minReferenceDate.getTime()) {
    const errorMsg = minReferenceLabel
      ? `The selected reach-by time (${humanStr}) must be after the ${minReferenceLabel}.`
      : `The selected reach-by time (${humanStr}) has already passed. Please select a future date and time.`;
    return {
      error: errorMsg,
      targetDate,
      formattedHuman: humanStr,
    };
  }

  return {
    unixSeconds: parsed.unixSeconds,
    targetDate,
    formattedHuman: humanStr,
  };
}
