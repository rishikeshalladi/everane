/* Everane demo dataset.
 *
 * Deterministic, and anchored to "today" so the demo always looks current no
 * matter when someone opens the link. Three ordinary medications, three weeks
 * of adherence that is mostly kept but believably imperfect, a few dose notes,
 * and a short doctor conversation.
 */
(function () {
  'use strict';

  // An already-running tour resumes from sessionStorage on every page, so the
  // profile flag alone is not enough to keep it out of the demo.
  try { sessionStorage.removeItem('everaneTutorialState'); } catch (_) {}
  try { localStorage.setItem('everaneFirstTimePopupSeen', '1'); } catch (_) {}

  const TZ_OFFSET_DAYS_HISTORY = 21;

  const iso = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const addDays = (d, n) => { const c = new Date(d); c.setDate(c.getDate() + n); return c; };
  const atTime = (d, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const c = new Date(d); c.setHours(h, m, 0, 0); return c;
  };

  // Small deterministic PRNG so the same day always renders the same history.
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const uid = 'demo-user';

  function weeklySchedules(times, startDate) {
    const out = [];
    times.forEach((t, ti) => {
      for (let wd = 0; wd < 7; wd++) {
        out.push({
          scheduleId: `sch_demo_${ti}_${wd}`,
          type: 'WEEKLY',
          weekday: wd,
          time: t,
          everyWeeks: 1,
          startDate,
          endDate: null
        });
      }
    });
    return out;
  }

  const startDate = iso(addDays(today, -60));

  const MEDS = [
    {
      id: 'demo-metformin',
      name: 'Metformin',
      dosage: 1,
      strength: '500 mg',
      times: ['08:00', '20:00'],
      bottles: [`${iso(addDays(today, 240)).split('-').reverse().join('/')}/60`],
      adherence: 0.93,
      colour: 'white'
    },
    {
      id: 'demo-lisinopril',
      name: 'Lisinopril',
      dosage: 1,
      strength: '10 mg',
      times: ['08:00'],
      bottles: [],
      adherence: 0.90,
      colour: 'pink'
    },
    {
      id: 'demo-atorvastatin',
      name: 'Atorvastatin',
      dosage: 1,
      strength: '20 mg',
      times: ['21:00'],
      bottles: [],
      adherence: 0.81,
      colour: 'white'
    }
  ];

  // Notes a real person might actually leave. Stored the way notes.html reads
  // them: medication.notes["YYYY-MM-DD_<dose>"] = [doseNumber, text, feeling 1-5].
  // Keyed here by days-back so the demo always has recent entries, including
  // today, rather than landing a visitor on an empty page.
  const NOTES = {
    'demo-metformin': {
      '0_1': [1, 'Took it with breakfast. No stomach upset this morning.', 4],
      '2_2': [2, 'Had this one a bit late \u2014 forgot until after dinner.', 3],
      '9_2': [2, 'Felt a little queasy about an hour after. Will mention to Dr. Hale.', 2],
      '17_1': [1, 'Fine today. Appetite normal.', 4]
    },
    'demo-lisinopril': {
      '0_1': [1, 'Blood pressure this morning was 126/78.', 4],
      '4_1': [1, 'Slight dizziness when standing up quickly.', 3],
      '13_1': [1, 'BP 128/80. Steady all week.', 4]
    },
    'demo-atorvastatin': {
      '1_1': [1, 'No muscle aches so far.', 5],
      '6_1': [1, 'Fell asleep before taking it. Setting a louder alarm.', 2]
    }
  };

  function buildMedication(spec, idx) {
    const rand = rng(1000 + idx * 7919);
    const doses = {};

    for (let back = TZ_OFFSET_DAYS_HISTORY; back >= 0; back--) {
      const day = addDays(today, -back);
      const dayIso = iso(day);

      spec.times.forEach((time, i) => {
        const doseNumber = i + 1;
        const key = `${dayIso}_${doseNumber}`;
        const when = atTime(day, time);

        // Doses still in the future today simply have no record yet.
        if (when > new Date()) return;

        const taken = rand() < spec.adherence;
        // A believable "took it, but late" spread.
        const minsLate = Math.floor(rand() * 26) - 4;
        const takenAt = new Date(when.getTime() + minsLate * 60000);

        doses[key] = taken
          ? { date: dayIso, doseNumber, time, taken: true, takenAt: takenAt.toISOString() }
          : { date: dayIso, doseNumber, time, taken: false, takenAt: null, autoMarked: true };

      });
    }

    // Translate the days-back note keys into real dated keys.
    const notes = {};
    Object.keys(NOTES[spec.id] || {}).forEach(k => {
      const [back, doseNumber] = k.split('_').map(Number);
      const dayIso = iso(addDays(today, -back));
      notes[`${dayIso}_${doseNumber}`] = NOTES[spec.id][k];
    });

    return {
      name: spec.name,
      dosage: spec.dosage,
      strength: spec.strength,
      schedules: weeklySchedules(spec.times, startDate),
      times: spec.times,
      daysOfWeek: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      timesPerDay: spec.times.length,
      reminderMethod: 'E',
      reminderChannels: ['email', 'push'],
      startDate,
      endDate: null,
      bottles: spec.bottles,
      stock: spec.bottles.length,
      skipBottleTracking: spec.bottles.length === 0,
      deletedStatus: false,
      classifications: { color: spec.colour, shape: 'round', form: 'tablet' },
      groups: [],
      doses,
      notes,
      createdAt: addDays(today, -60).toISOString()
    };
  }

  const medications = {};
  MEDS.forEach((m, i) => { medications[m.id] = buildMedication(m, i); });

  const t = (daysBack, hhmm) => atTime(addDays(today, -daysBack), hhmm).toISOString();

  const doctorEdits = {
    'demo-msg-1': {
      type: 'Dosage change',
      details: 'Let’s keep Metformin at 500 mg twice daily for now. Your last A1C looked good and I’d rather not change two things at once.',
      doctorName: 'Dr. Hale',
      createdAt: t(12, '14:20'),
      status: 'pending',
      replies: [
        {
          message: 'Understood — I’ll stay on the current dose and we can revisit at the next visit.',
          doctorName: 'Dr. Hale',
          createdAt: t(11, '09:05')
        }
      ]
    },
    'demo-msg-2': {
      type: 'Question',
      details: 'I’ve been a little dizzy when I stand up quickly since starting Lisinopril. Is that something to worry about?',
      doctorName: 'Dr. Hale',
      source: 'patient',
      patientName: 'Margaret Chen',
      createdAt: t(4, '08:42'),
      status: 'pending',
      replies: [
        {
          message: 'That’s a common early effect. Stand up slowly and keep your fluids up. If it doesn’t settle within two weeks, call the office.',
          doctorName: 'Dr. Hale',
          createdAt: t(4, '16:10')
        }
      ]
    },
    'demo-msg-3': {
      type: 'Reminder',
      details: 'Please book a fasting lipid panel before your next appointment so we can see how the Atorvastatin is working.',
      doctorName: 'Dr. Hale',
      createdAt: t(2, '11:30'),
      status: 'pending',
      replies: []
    }
  };

  const profile = {
    name: 'Margaret Chen',
    email: 'margaret.demo@everane.live',
    type: 'P',
    patientId: '4821903',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
    notification_reminders: ['30_minutes_before', 'at_time'],
    // The onboarding tour auto-starts for anyone who has not completed it.
    // A demo visitor should land on the finished product, not step 1 of 10.
    tutorialCompleted: true,
    // auth-guard bounces medicom.html to the profile unless doctor access is
    // set up, so the demo account has it enabled. Never used to authenticate
    // anything here: the demo has no backend.
    doctorPassword: 'demo-not-a-real-password',
    pushSubscriptions: [],
    caregivers: [],
    lastSentReminders: {},
    createdAt: addDays(today, -60).toISOString()
  };

  window.EVERANE_DEMO = {
    uid,
    profile,
    medications,
    doctorEdits,
    groups: {},
    notes: {}
  };
})();
