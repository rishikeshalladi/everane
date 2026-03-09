/**
 * Everane Schedule Utilities (Client-Side)
 *
 * Shared schedule logic for all HTML pages.
 * Supports WEEKLY and INTERVAL schedule types.
 * Dose numbers are per-day sequential (reset per day, ordered by time).
 *
 * Usage: <script src="schedule-utils.js"></script>
 * All functions are exposed via window.ScheduleUtils
 */
(function() {
  'use strict';

  const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;
  const MS_PER_WEEK = 7 * MS_PER_DAY;

  // ========================
  // Date Helpers
  // ========================

  /** Get start of day (midnight) for a Date */
  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /** Get end of day (23:59:59.999) for a Date */
  function endOfDay(date) {
    const d = new Date(date);
    d.setHours(23, 59, 59, 999);
    return d;
  }

  /** Get ISO date string YYYY-MM-DD from a Date */
  function toISODate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Parse a date string in various formats to a Date object (local time, start of day) */
  function parseDate(dateStr) {
    if (!dateStr || dateStr === 'N/A') return null;
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
      const [y, m, d] = dateStr.split('T')[0].split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    // M/D/YYYY
    if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(dateStr)) {
      const parts = dateStr.split('/');
      return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
    }
    // Try native parsing
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? null : d;
  }

  /** Parse "HH:MM" to {hours, minutes} */
  function parseTime(timeStr) {
    if (!timeStr) return null;
    const [h, m] = timeStr.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;
    return { hours: h, minutes: m };
  }

  /** Create a Date from a date and a time string */
  function dateWithTime(date, timeStr) {
    const t = parseTime(timeStr);
    if (!t) return null;
    const d = new Date(date);
    d.setHours(t.hours, t.minutes, 0, 0);
    return d;
  }

  /** Normalize a date string to YYYY-MM-DD or null */
  function normalizeDate(dateStr) {
    const d = parseDate(dateStr);
    return d ? toISODate(d) : null;
  }

  // ========================
  // Migration
  // ========================

  /**
   * Convert old flat format (daysOfWeek, timesPerDay, times) to schedules[] array.
   * Returns an object with { schedules: [...] }
   */
  function migrateOldFormat(medData) {
    const schedules = [];

    // Get days (as weekday numbers 0-6)
    const rawDays = medData.daysOfWeek || medData.days || [];
    let dayNumbers = [];

    if (rawDays.length > 0) {
      dayNumbers = rawDays.map(d => {
        if (typeof d === 'number') return d % 7;
        const idx = WEEKDAY_NAMES.indexOf(String(d).toLowerCase());
        return idx >= 0 ? idx : null;
      }).filter(d => d !== null);
    } else {
      // Default: every day
      dayNumbers = [0, 1, 2, 3, 4, 5, 6];
    }

    // Get times
    let times = Array.isArray(medData.times) ? medData.times.filter(Boolean) : [];
    if (times.length === 0) {
      // Use defaults based on timesPerDay
      const tpd = medData.timesPerDay || 1;
      if (tpd === 1) times = ['09:00'];
      else if (tpd === 2) times = ['09:00', '21:00'];
      else if (tpd >= 3) times = ['09:00', '15:00', '21:00'];
    }
    times.sort();

    // Parse startDate/endDate
    const startDate = normalizeDate(medData.startDate);
    const endDate = normalizeDate(medData.endDate);

    // Create a WEEKLY schedule entry for each day + time combination
    for (const dayNum of dayNumbers) {
      for (const timeStr of times) {
        schedules.push({
          scheduleId: 'sch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
          type: 'WEEKLY',
          weekday: dayNum,
          time: timeStr,
          everyWeeks: 1,
          startDate: startDate,
          endDate: endDate,
          medId: medData.id || null
        });
      }
    }

    return { schedules };
  }

  // ========================
  // Core Schedule Logic
  // ========================

  /**
   * Check if a WEEKLY schedule produces a dose on the given date.
   * Returns the time string if yes, null if no.
   */
  function weeklyMatchesDate(schedule, date) {
    const dayOfWeek = date.getDay(); // 0=Sun, 1=Mon, ...
    if (dayOfWeek !== schedule.weekday) return null;

    // Check startDate boundary
    if (schedule.startDate) {
      const start = parseDate(schedule.startDate);
      if (start && startOfDay(date) < startOfDay(start)) return null;
    }

    // Check endDate boundary
    if (schedule.endDate) {
      const end = parseDate(schedule.endDate);
      if (end && startOfDay(date) > startOfDay(end)) return null;
    }

    // Check everyWeeks
    const everyWeeks = schedule.everyWeeks || 1;
    if (everyWeeks > 1 && schedule.startDate) {
      const start = parseDate(schedule.startDate);
      if (start) {
        const diffMs = startOfDay(date).getTime() - startOfDay(start).getTime();
        const diffWeeks = Math.round(diffMs / MS_PER_WEEK);
        if (diffWeeks < 0 || diffWeeks % everyWeeks !== 0) return null;
      }
    }

    return schedule.time || null;
  }

  /**
   * Get all dose times an INTERVAL schedule produces on the given date.
   * Returns an array of time strings (HH:MM).
   */
  function intervalDosesForDate(schedule, date) {
    if (!schedule.anchorDateTime || !schedule.interval) return [];

    const anchor = new Date(schedule.anchorDateTime);
    if (isNaN(anchor.getTime())) return [];

    // Check endDate boundary
    if (schedule.endDate) {
      const end = parseDate(schedule.endDate);
      if (end && startOfDay(date) > startOfDay(end)) return [];
    }

    // Check startDate (anchor acts as start)
    if (startOfDay(date) < startOfDay(anchor)) return [];

    const unit = (schedule.interval.unit || '').toUpperCase();
    const value = schedule.interval.value || 1;

    const dayStart = startOfDay(date).getTime();
    const dayEnd = endOfDay(date).getTime();
    const anchorMs = anchor.getTime();
    const times = [];

    if (unit === 'HOUR') {
      const intervalMs = value * MS_PER_HOUR;
      // Find the first occurrence on or after dayStart
      const diffFromAnchor = dayStart - anchorMs;
      let firstN;
      if (diffFromAnchor <= 0) {
        firstN = 0;
      } else {
        firstN = Math.ceil(diffFromAnchor / intervalMs);
      }

      // Iterate through all occurrences within this day
      for (let n = firstN; ; n++) {
        const occurrenceMs = anchorMs + n * intervalMs;
        if (occurrenceMs > dayEnd) break;
        if (occurrenceMs >= dayStart && occurrenceMs <= dayEnd) {
          const occ = new Date(occurrenceMs);
          const h = String(occ.getHours()).padStart(2, '0');
          const m = String(occ.getMinutes()).padStart(2, '0');
          times.push(`${h}:${m}`);
        }
      }
    } else if (unit === 'DAY') {
      const intervalMs = value * MS_PER_DAY;
      const diffMs = dayStart - startOfDay(anchor).getTime();
      if (diffMs >= 0 && diffMs % intervalMs === 0) {
        // This day matches the interval
        const h = String(anchor.getHours()).padStart(2, '0');
        const m = String(anchor.getMinutes()).padStart(2, '0');
        times.push(`${h}:${m}`);
      }
    } else if (unit === 'WEEK') {
      const intervalMs = value * MS_PER_WEEK;
      const diffMs = dayStart - startOfDay(anchor).getTime();
      if (diffMs >= 0 && diffMs % intervalMs === 0) {
        const h = String(anchor.getHours()).padStart(2, '0');
        const m = String(anchor.getMinutes()).padStart(2, '0');
        times.push(`${h}:${m}`);
      }
    }

    return times;
  }

  /**
   * Get all scheduled doses for a given date.
   * Returns array of { time, doseNumber, scheduleId, scheduleType } sorted by time,
   * with per-day sequential dose numbers.
   */
  function getScheduledDosesForDate(schedules, date) {
    if (!Array.isArray(schedules) || schedules.length === 0) return [];

    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return [];

    const rawDoses = [];

    for (const schedule of schedules) {
      if (!schedule || !schedule.type) continue;

      if (schedule.type === 'WEEKLY') {
        const time = weeklyMatchesDate(schedule, d);
        if (time !== null) {
          rawDoses.push({
            time: time,
            scheduleId: schedule.scheduleId || null,
            scheduleType: 'WEEKLY'
          });
        }
      } else if (schedule.type === 'INTERVAL') {
        const times = intervalDosesForDate(schedule, d);
        for (const time of times) {
          rawDoses.push({
            time: time,
            scheduleId: schedule.scheduleId || null,
            scheduleType: 'INTERVAL'
          });
        }
      }
    }

    // Sort by time (null times go last)
    rawDoses.sort((a, b) => {
      if (a.time === b.time) return 0;
      if (!a.time) return 1;
      if (!b.time) return -1;
      return a.time.localeCompare(b.time);
    });

    // Deduplicate same time from same schedule
    const seen = new Set();
    const deduped = [];
    for (const dose of rawDoses) {
      const key = `${dose.time || 'null'}|${dose.scheduleId || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(dose);
      }
    }

    // Assign per-day sequential dose numbers
    return deduped.map((dose, idx) => ({
      ...dose,
      doseNumber: idx + 1
    }));
  }

  /**
   * Check if any dose is scheduled for the given date.
   */
  function isScheduledForDate(schedules, date) {
    return getScheduledDosesForDate(schedules, date).length > 0;
  }

  /**
   * Compute the next upcoming dose from now.
   * Looks ahead up to 14 days.
   * Returns { time, weekday, doseNumber, dateTime, totalDoses, date } or null.
   */
  function computeNextDose(schedules, now) {
    if (!Array.isArray(schedules) || schedules.length === 0) return null;

    const nowDate = now instanceof Date ? now : new Date(now);

    for (let offset = 0; offset < 14; offset++) {
      const candidateDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + offset);
      const doses = getScheduledDosesForDate(schedules, candidateDate);

      for (const dose of doses) {
        const dt = dose.time ? dateWithTime(candidateDate, dose.time) : candidateDate;
        if (dt && dt >= nowDate) {
          return {
            time: dose.time,
            weekday: WEEKDAY_NAMES[candidateDate.getDay()],
            doseNumber: dose.doseNumber,
            totalDoses: doses.length,
            dateTime: dt,
            date: toISODate(candidateDate),
            scheduleId: dose.scheduleId
          };
        }
      }
    }

    return null;
  }

  /**
   * Determine the "current" dose using the 45-min/90-min rules.
   * Includes yesterday through next 7 days.
   * Returns { time, weekday, doseNumber, totalDoses, dateTime, date, scheduleId } or null.
   */
  function determineCurrentDose(schedules, now) {
    if (!Array.isArray(schedules) || schedules.length === 0) return null;

    const nowDate = now instanceof Date ? now : new Date(now);
    const candidates = [];

    // Build candidates from yesterday through next 7 days
    for (let offset = -1; offset < 7; offset++) {
      const candidateDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + offset);
      const doses = getScheduledDosesForDate(schedules, candidateDate);

      for (const dose of doses) {
        const dt = dose.time ? dateWithTime(candidateDate, dose.time) : startOfDay(candidateDate);
        if (dt) {
          candidates.push({
            time: dose.time,
            weekday: WEEKDAY_NAMES[candidateDate.getDay()],
            doseNumber: dose.doseNumber,
            totalDoses: doses.length,
            dateTime: dt,
            date: toISODate(candidateDate),
            scheduleId: dose.scheduleId
          });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Sort by dateTime
    candidates.sort((a, b) => a.dateTime - b.dateTime);

    // Find next dose (first >= now)
    const nextDose = candidates.find(c => c.dateTime >= nowDate);
    // Find previous dose (last < now)
    const previousDoses = candidates.filter(c => c.dateTime < nowDate);
    const previousDose = previousDoses.length > 0 ? previousDoses[previousDoses.length - 1] : null;

    // If no next dose, wrap to first candidate
    if (!nextDose) return candidates[0];
    // If no previous dose, use next
    if (!previousDose) return nextDose;

    // Calculate time differences in minutes
    const timeToNext = (nextDose.dateTime - nowDate) / (1000 * 60);
    const timeSincePrevious = (nowDate - previousDose.dateTime) / (1000 * 60);
    const timeBetweenDoses = (nextDose.dateTime - previousDose.dateTime) / (1000 * 60);

    // Rule 1: If within 45 minutes of previous dose, use previous dose
    if (timeSincePrevious <= 45) {
      return previousDose;
    }

    // Rule 2: If doses are less than 90 minutes apart, use whichever is closer
    if (timeBetweenDoses < 90) {
      return timeToNext < timeSincePrevious ? nextDose : previousDose;
    }

    // Default: use next dose
    return nextDose;
  }

  /**
   * Estimate total doses per week from schedules.
   */
  function getPerWeekCount(schedules) {
    if (!Array.isArray(schedules) || schedules.length === 0) return 0;

    let total = 0;
    for (const sch of schedules) {
      if (sch.type === 'WEEKLY') {
        const everyWeeks = sch.everyWeeks || 1;
        total += 1 / everyWeeks;
      } else if (sch.type === 'INTERVAL') {
        const unit = (sch.interval?.unit || '').toUpperCase();
        const value = sch.interval?.value || 1;
        if (unit === 'HOUR') total += (7 * 24) / value;
        else if (unit === 'DAY') total += 7 / value;
        else if (unit === 'WEEK') total += 1 / value;
      }
    }
    return Math.round(total);
  }

  /**
   * Estimate the max doses on any single day.
   * Uses a representative week starting from today.
   */
  function getPerDayMax(schedules) {
    if (!Array.isArray(schedules) || schedules.length === 0) return 0;

    const today = new Date();
    let max = 0;
    for (let offset = 0; offset < 7; offset++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      const count = getScheduledDosesForDate(schedules, d).length;
      if (count > max) max = count;
    }
    return max;
  }

  // ========================
  // Expose API
  // ========================

  window.ScheduleUtils = {
    migrateOldFormat,
    getScheduledDosesForDate,
    isScheduledForDate,
    computeNextDose,
    determineCurrentDose,
    getPerWeekCount,
    getPerDayMax,
    normalizeDate,
    parseDate,
    toISODate,
    WEEKDAY_NAMES
  };

})();
