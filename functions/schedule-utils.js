/**
 * Everane Schedule Utilities (Server-Side / Node.js)
 *
 * Luxon-based version for Cloud Functions.
 * Same logic as the client-side schedule-utils.js but uses Luxon DateTime
 * for timezone-aware calculations.
 */
'use strict';

const { DateTime } = require('luxon');

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const MS_PER_WEEK = 7 * MS_PER_DAY;

// ========================
// Date Helpers
// ========================

/** Convert a Luxon DateTime or JS Date to a plain JS Date at start of day */
function toJsDate(dt) {
  if (dt instanceof DateTime) {
    return new Date(dt.year, dt.month - 1, dt.day);
  }
  if (dt instanceof Date) return dt;
  return new Date(dt);
}

/** Get start of day (midnight) for a Date */
function startOfDay(date) {
  const d = new Date(toJsDate(date));
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Get end of day for a Date */
function endOfDay(date) {
  const d = new Date(toJsDate(date));
  d.setHours(23, 59, 59, 999);
  return d;
}

/** Get ISO date string YYYY-MM-DD */
function toISODate(date) {
  if (date instanceof DateTime) return date.toISODate();
  const d = toJsDate(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a date string to a JS Date (start of day) */
function parseDate(dateStr) {
  if (!dateStr || dateStr === 'N/A') return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    const [y, m, d] = dateStr.split('T')[0].split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(dateStr)) {
    const parts = dateStr.split('/');
    return new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
  }
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

/** Create a Date from a date and time string */
function dateWithTime(date, timeStr) {
  const t = parseTime(timeStr);
  if (!t) return null;
  const d = new Date(toJsDate(date));
  d.setHours(t.hours, t.minutes, 0, 0);
  return d;
}

/** Normalize date string to YYYY-MM-DD or null */
function normalizeDate(dateStr) {
  const d = parseDate(dateStr);
  return d ? toISODate(d) : null;
}

// ========================
// Migration
// ========================

function migrateOldFormat(medData) {
  const schedules = [];

  const rawDays = medData.daysOfWeek || medData.days || [];
  let dayNumbers = [];

  if (rawDays.length > 0) {
    dayNumbers = rawDays.map(d => {
      if (typeof d === 'number') return d % 7;
      const idx = WEEKDAY_NAMES.indexOf(String(d).toLowerCase());
      return idx >= 0 ? idx : null;
    }).filter(d => d !== null);
  } else {
    dayNumbers = [0, 1, 2, 3, 4, 5, 6];
  }

  let times = Array.isArray(medData.times) ? medData.times.filter(Boolean) : [];
  if (times.length === 0) {
    const tpd = medData.timesPerDay || 1;
    if (tpd === 1) times = ['09:00'];
    else if (tpd === 2) times = ['09:00', '21:00'];
    else if (tpd >= 3) times = ['09:00', '15:00', '21:00'];
  }
  times.sort();

  const startDate = normalizeDate(medData.startDate);
  const endDate = normalizeDate(medData.endDate);

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

function weeklyMatchesDate(schedule, date) {
  const d = toJsDate(date);
  const dayOfWeek = d.getDay();
  if (dayOfWeek !== schedule.weekday) return null;

  if (schedule.startDate) {
    const start = parseDate(schedule.startDate);
    if (start && startOfDay(d) < startOfDay(start)) return null;
  }

  if (schedule.endDate) {
    const end = parseDate(schedule.endDate);
    if (end && startOfDay(d) > startOfDay(end)) return null;
  }

  const everyWeeks = schedule.everyWeeks || 1;
  if (everyWeeks > 1 && schedule.startDate) {
    const start = parseDate(schedule.startDate);
    if (start) {
      const diffMs = startOfDay(d).getTime() - startOfDay(start).getTime();
      const diffWeeks = Math.round(diffMs / MS_PER_WEEK);
      if (diffWeeks < 0 || diffWeeks % everyWeeks !== 0) return null;
    }
  }

  return schedule.time || null;
}

function intervalDosesForDate(schedule, date) {
  if (!schedule.anchorDateTime || !schedule.interval) return [];

  const anchor = new Date(schedule.anchorDateTime);
  if (isNaN(anchor.getTime())) return [];

  const d = toJsDate(date);

  if (schedule.endDate) {
    const end = parseDate(schedule.endDate);
    if (end && startOfDay(d) > startOfDay(end)) return [];
  }

  if (startOfDay(d) < startOfDay(anchor)) return [];

  const unit = (schedule.interval.unit || '').toUpperCase();
  const value = schedule.interval.value || 1;

  const dayStart = startOfDay(d).getTime();
  const dayEnd = endOfDay(d).getTime();
  const anchorMs = anchor.getTime();
  const times = [];

  if (unit === 'HOUR') {
    const intervalMs = value * MS_PER_HOUR;
    const diffFromAnchor = dayStart - anchorMs;
    let firstN = diffFromAnchor <= 0 ? 0 : Math.ceil(diffFromAnchor / intervalMs);

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

function getScheduledDosesForDate(schedules, date) {
  if (!Array.isArray(schedules) || schedules.length === 0) return [];

  const d = toJsDate(date);
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

  rawDoses.sort((a, b) => {
    if (a.time === b.time) return 0;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return a.time.localeCompare(b.time);
  });

  const seen = new Set();
  const deduped = [];
  for (const dose of rawDoses) {
    const key = `${dose.time || 'null'}|${dose.scheduleId || ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(dose);
    }
  }

  return deduped.map((dose, idx) => ({
    ...dose,
    doseNumber: idx + 1
  }));
}

function isScheduledForDate(schedules, date) {
  return getScheduledDosesForDate(schedules, date).length > 0;
}

function computeNextDose(schedules, now) {
  if (!Array.isArray(schedules) || schedules.length === 0) return null;

  const nowDate = toJsDate(now);

  for (let offset = 0; offset < 14; offset++) {
    const candidateDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + offset);
    const doses = getScheduledDosesForDate(schedules, candidateDate);

    for (const dose of doses) {
      const dt = dose.time ? dateWithTime(candidateDate, dose.time) : candidateDate;
      if (dt && dt >= nowDate) {
        return {
          time: dose.time,
          timeStr: dose.time,
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

function determineCurrentDose(schedules, now) {
  if (!Array.isArray(schedules) || schedules.length === 0) return null;

  const nowDate = toJsDate(now);
  const candidates = [];

  for (let offset = -1; offset < 7; offset++) {
    const candidateDate = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate() + offset);
    const doses = getScheduledDosesForDate(schedules, candidateDate);

    for (const dose of doses) {
      const dt = dose.time ? dateWithTime(candidateDate, dose.time) : startOfDay(candidateDate);
      if (dt) {
        candidates.push({
          time: dose.time,
          timeStr: dose.time,
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

  candidates.sort((a, b) => a.dateTime - b.dateTime);

  const nextDose = candidates.find(c => c.dateTime >= nowDate);
  const previousDoses = candidates.filter(c => c.dateTime < nowDate);
  const previousDose = previousDoses.length > 0 ? previousDoses[previousDoses.length - 1] : null;

  if (!nextDose) return candidates[0];
  if (!previousDose) return nextDose;

  const timeToNext = (nextDose.dateTime - nowDate) / (1000 * 60);
  const timeSincePrevious = (nowDate - previousDose.dateTime) / (1000 * 60);
  const timeBetweenDoses = (nextDose.dateTime - previousDose.dateTime) / (1000 * 60);

  if (timeSincePrevious <= 45) return previousDose;
  if (timeBetweenDoses < 90) return timeToNext < timeSincePrevious ? nextDose : previousDose;
  return nextDose;
}

function getPerWeekCount(schedules) {
  if (!Array.isArray(schedules) || schedules.length === 0) return 0;

  let total = 0;
  for (const sch of schedules) {
    if (sch.type === 'WEEKLY') {
      total += 1 / (sch.everyWeeks || 1);
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

module.exports = {
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
