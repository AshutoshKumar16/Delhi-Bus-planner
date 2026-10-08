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

/**
 * Returns default reach-by time formatted as "HH:mm" for HTML5 time inputs.
 * Defaults to "11:00" for daytime planning, or 1 hour in future if already past 11:00.
 */
export function getDefaultReachByTime(d: Date = new Date()): string {
  const hours = d.getHours();
  if (hours < 10) {
    return '11:00';
  }
  // Otherwise 1 hour ahead rounded to next 15 mins
  const future = new Date(d.getTime() + 60 * 60 * 1000);
  const roundedMins = Math.ceil(future.getMinutes() / 15) * 15;
  if (roundedMins === 60) {
    future.setHours(future.getHours() + 1);
    future.setMinutes(0);
  } else {
    future.setMinutes(roundedMins);
  }
  const hStr = String(future.getHours()).padStart(2, '0');
  const mStr = String(future.getMinutes()).padStart(2, '0');
  return `${hStr}:${mStr}`;
}

/**
 * Formats a backend timestamp (e.g. "2026-10-06 11:00:00 IST" or "11:00")
 * into human-friendly 12-hour clock format (e.g. "11:00 AM").
 */
export function formatTimeTo12Hour(fullStr?: string): string {
  if (!fullStr) return '--:--';
  const match = fullStr.match(/(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|IST)?/i);
  if (match) {
    let hours = parseInt(match[2], 10);
    const minutes = match[3];
    const modifier = match[4]?.toUpperCase();

    if (modifier === 'AM' || modifier === 'PM') {
      return `${hours}:${minutes} ${modifier}`;
    }

    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    if (hours === 0) hours = 12;
    return `${hours}:${minutes} ${ampm}`;
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
  const time12h = formatTimeTo12Hour(
    `${targetDate.getHours()}:${String(targetDate.getMinutes()).padStart(2, '0')}`
  );

  const refMidnight = new Date(
    referenceDate.getFullYear(),
    referenceDate.getMonth(),
    referenceDate.getDate()
  ).getTime();

  const targetMidnight = new Date(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  ).getTime();

  const diffDays = Math.round((targetMidnight - refMidnight) / (24 * 60 * 60 * 1000));

  if (diffDays === 0) {
    return `Today · ${time12h}`;
  } else if (diffDays === 1) {
    return `Tomorrow · ${time12h}`;
  } else if (diffDays === -1) {
    return `Yesterday · ${time12h}`;
  } else {
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${monthNames[targetDate.getMonth()]} ${targetDate.getDate()} · ${time12h}`;
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
  const startDate = new Date(startTs * 1000);
  const endDate = new Date(endTs * 1000);
  const startStr = formatTimeTo12Hour(
    `${startDate.getHours()}:${String(startDate.getMinutes()).padStart(2, '0')}`
  );
  const endStr = formatTimeTo12Hour(
    `${endDate.getHours()}:${String(endDate.getMinutes()).padStart(2, '0')}`
  );
  return `${startStr} – ${endStr}`;
}

/**
 * Combines date string ("YYYY-MM-DD") and time string ("HH:mm") into a local Date,
 * validates against past deadlines, and converts to Unix seconds.
 */
export function combineDateAndTimeToUnix(
  dateStr: string,
  timeStr: string,
  referenceDate: Date = new Date()
): CombineDateTimeResult {
  const trimmedDate = (dateStr || '').trim();
  const trimmedTime = (timeStr || '').trim();

  if (!trimmedDate) {
    return { error: 'Please select a reach-by date.' };
  }
  if (!trimmedTime) {
    return { error: 'Please select a reach-by time.' };
  }

  // Parse YYYY-MM-DD
  const dateParts = trimmedDate.split('-');
  if (dateParts.length !== 3) {
    return { error: 'Invalid date format. Please select a valid date.' };
  }
  const year = parseInt(dateParts[0], 10);
  const month = parseInt(dateParts[1], 10) - 1;
  const day = parseInt(dateParts[2], 10);

  // Parse HH:mm (HTML5 time format) or with seconds/12h
  const timeRegex = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([aApP][mM])?$/;
  const match = trimmedTime.match(timeRegex);
  if (!match) {
    return { error: 'Invalid time format. Please select a valid time.' };
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

  const targetDate = new Date(year, month, day, hours, minutes, seconds, 0);

  if (isNaN(targetDate.getTime())) {
    return { error: 'Invalid date or time specified.' };
  }

  const humanStr = formatHumanDeadline(targetDate, referenceDate);

  // Validate that deadline is not in the past relative to referenceDate
  if (targetDate.getTime() <= referenceDate.getTime()) {
    return {
      error: `The selected reach-by time (${humanStr}) has already passed. Please select a future date and time.`,
      targetDate,
      formattedHuman: humanStr,
    };
  }

  return {
    unixSeconds: Math.floor(targetDate.getTime() / 1000),
    targetDate,
    formattedHuman: humanStr,
  };
}
