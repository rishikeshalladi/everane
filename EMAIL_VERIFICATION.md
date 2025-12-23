# Email System Verification

## All Email Functions Status

### ✅ 1. Daily Agenda Email (`sendDailyAgenda`)
- **Schedule**: Daily at 9:00 AM Pacific Time
- **Function**: `exports.sendDailyAgenda`
- **What it sends**:
  - Complete schedule of all medications for today
  - All doses with times
  - Bottle expiration alerts (if any bottles expiring within 7 days)
  - Includes dosage information
- **Status**: ✅ WORKING
- **Location**: Lines 1578-1618

### ✅ 2. Medication Reminder Emails (`sendMedicationReminders`)
- **Schedule**: Every 1 minute
- **Function**: `exports.sendMedicationReminders`
- **What it sends**:
  - Reminders based on user preferences (30 min before, 15 min before, at time, etc.)
  - Only sends for CURRENT DOSE (not future doses)
  - Skips advance reminders if dose is already taken
  - Sends "Already Taken" email at scheduled time if dose was taken early
  - Includes today's complete schedule
  - Includes stock alerts (no bottles, out of stock) at 9 AM
  - Includes bottle expiration alerts at 9 AM
- **Status**: ✅ WORKING
- **Location**: Lines 1265-1564

### ✅ 3. Stock Alerts (No Bottles / Out of Stock)
- **When**: Included in medication reminder emails at 9:00 AM
- **Function**: Part of `sendMedicationReminders`
- **What it checks**:
  - No bottles entered: `med.bottles.length === 0`
  - Out of stock: `med.stock === 0`
- **What it sends**:
  - Alert in reminder email at 9 AM
  - Separate alerts-only email if no reminders at 9 AM
- **Status**: ✅ WORKING
- **Location**: Lines 1370-1377, 1516-1552

### ✅ 4. Bottle Expiration Alerts
- **When**: 
  - Included in daily agenda at 9:00 AM
  - Included in medication reminder emails at 9:00 AM
- **Function**: `getBottleAlertsForUser`
- **What it checks**:
  - Bottles expiring within 7 days (`EXPIRATION_ALERT_DAYS = 7`)
  - Already expired bottles
- **What it sends**:
  - If alternate bottles available: "Switch to one of your other bottles"
  - If no alternate bottles: "Please purchase a new bottle"
  - Includes expiration date
- **Status**: ✅ WORKING
- **Location**: Lines 172-214, 1608, 1644

### ✅ 5. Missed Dose Emails
- **When**: Automatically triggered when dose is 45+ minutes past scheduled time and not marked
- **Function**: `checkAndMarkMissedDoses` (called from `sendMedicationReminders`)
- **What it does**:
  - Checks current dose only (not all doses)
  - If 45+ minutes past scheduled time
  - And dose is not marked (neither taken nor not taken)
  - Automatically marks as `taken: false` with `autoMarked: true`
  - Sends email notification
- **What it sends**:
  - Subject: "Missed Dose: [Medication Name]" or "Missed Doses: X medications"
  - Lists all missed medications
  - Time since scheduled
  - Message: "If this is a mistake, please update in MedTracker"
- **Status**: ✅ WORKING
- **Location**: Lines 750-873, 1554-1555

## Email Integration Points

### Stock Alerts Integration
- **No Bottles**: Detected at line 1371-1373
- **Out of Stock**: Detected at line 1374-1376
- **Included in**: Reminder emails at 9 AM (line 1516)
- **Fallback**: Alerts-only email if no reminders at 9 AM (line 1549-1551)

### Expiration Alerts Integration
- **Function**: `getBottleAlertsForUser` (line 172)
- **Threshold**: 7 days before expiration
- **Included in**: 
  - Daily agenda (line 1608)
  - Reminder emails at 9 AM (via `sendCombinedReminderEmail`)
- **Format**: Handles multiple date formats (M/d/yyyy, MM/dd/yyyy, ISO)

### Reminder Preferences
- **Default**: 30 minutes before + at time
- **Options**: 1 day, 5 hours, 3 hours, 2 hours, 1 hour, 30 min, 15 min, 10 min, 5 min, at time
- **Location**: Lines 1302-1308

## Current Dose Logic (CRITICAL)
- **Function**: `determineCurrentDoseForEmail` (lines 300-450)
- **Rules**:
  1. Assign to next dose
  2. If within 45 minutes of previous dose, set to previous
  3. If next and previous are < 90 minutes apart, choose closer one
- **Only sends emails for current dose** - not future doses
- **Skips advance reminders if current dose already taken**

## Data Normalization
All medication data is normalized to handle various Firebase formats:
- `daysOfWeek` / `days` (both supported)
- `reminderMethod`: 'E', 'ES', 'Email' (all supported)
- `bottles`: Array format with date parsing
- `doses`: Object format with date_doseNumber keys
- `deletedStatus`: Boolean check

## Email Templates
1. **Combined Reminder Email** (`sendCombinedReminderEmail`):
   - HTML and plain text versions
   - Includes medication details, times, dosages
   - Includes stock alerts
   - Includes bottle expiration alerts
   - Includes today's schedule
   - "Already Taken" status if applicable

2. **Daily Agenda Email** (`sendAgendaSummaryEmail`):
   - Complete schedule for today
   - All doses with times
   - Bottle expiration alerts

3. **Missed Dose Email** (`sendMissedDoseEmail`):
   - List of missed medications
   - Time since scheduled
   - Instructions to update if mistake

## Verification Checklist

- ✅ Daily agenda sends at 9 AM with schedule + expiration alerts
- ✅ Medication reminders send based on user preferences
- ✅ Reminders only for current dose (not future doses)
- ✅ Stock alerts (no bottles/out of stock) included at 9 AM
- ✅ Bottle expiration alerts (7 days before) included in emails
- ✅ Missed dose auto-marking (45 minutes past) works
- ✅ Missed dose emails send when auto-marked
- ✅ "Already Taken" emails send at scheduled time
- ✅ Advance reminders skip if dose already taken
- ✅ Data normalization handles all Firebase formats
- ✅ Email + SMS reminder method ('ES') supported

## All Email Scenarios

1. **Daily at 9 AM**: Agenda email with schedule + expiration alerts
2. **Every minute**: Check for medication reminders (current dose only)
3. **At reminder times**: Send reminder emails based on preferences
4. **At scheduled time**: Send "at time" reminder (or "already taken" if applicable)
5. **45+ minutes past**: Auto-mark missed doses and send email
6. **Stock alerts**: Included in 9 AM emails (no bottles, out of stock)
7. **Expiration alerts**: Included in 9 AM emails (expiring within 7 days)

## Notes
- All emails respect `reminderMethod` (only 'E' or 'ES' get emails)
- All emails check `deletedStatus` (deleted medications skipped)
- All emails check `endDate` (medications past end date skipped)
- All emails check `daysOfWeek` (only scheduled days)
- All emails use Pacific Time zone (America/Los_Angeles)

