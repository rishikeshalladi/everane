# 📧 Complete Email Scenarios Documentation

## ALL POSSIBLE EMAIL SCENARIOS

### 1. **Daily Agenda Email** (`sendDailyAgenda`)
- **When**: Every day at 9:00 AM Pacific Time
- **Trigger**: Scheduled Cloud Function (cron: `0 9 * * *`)
- **What it sends**: 
  - Today's complete medication schedule (all doses for the day)
  - Bottle expiration alerts (if any bottles expiring within 7 days)
- **Conditions**:
  - ✅ User has email address
  - ✅ User hasn't received agenda today (`lastAgendaSentDate !== today`)
  - ✅ User has at least one medication scheduled for today
  - ✅ Medication is not deleted
  - ✅ Medication is scheduled for today's day of week
  - ✅ Medication hasn't passed end date
- **Frequency**: Once per day maximum
- **Function**: `sendAgendaSummaryEmail()`

---

### 2. **Medication Reminder Emails** (`sendMedicationReminders`)
- **When**: Runs every 1 minute (checks continuously)
- **Trigger**: Scheduled Cloud Function (cron: `every 1 minutes`)
- **What it sends**: Reminders based on user's notification preferences

#### 2A. **At-Time Reminders** (`at_time` offset)
- **When**: Exactly at the scheduled medication time
- **Conditions**:
  - ✅ Medication `reminderMethod === 'E'` (Email)
  - ✅ Medication not deleted
  - ✅ Medication scheduled for today
  - ✅ Current time is within 5-minute window of scheduled time
  - ✅ Reminder not already sent today (tracked by `lastSentReminders`)
- **What's included**:
  - All medications due at that exact time
  - Today's full schedule (if at-time reminder)
  - Alerts (no bottles/out of stock) - ONLY if at 9:00 AM
  - Bottle expiration alerts (if any)
- **Frequency**: Once per medication per time per day

#### 2B. **Advance Reminders** (before scheduled time)
Available offsets (from user's `notification_reminders` profile setting):
- `1_day_before` - 1 day (1440 minutes) before
- `5_hours_before` - 5 hours (300 minutes) before
- `3_hours_before` - 3 hours (180 minutes) before
- `2_hours_before` - 2 hours (120 minutes) before
- `1_hour_before` - 1 hour (60 minutes) before
- `30_minutes_before` - 30 minutes before
- `15_minutes_before` - 15 minutes before
- `10_minutes_before` - 10 minutes before
- `5_minutes_before` - 5 minutes before

- **When**: At the offset time before scheduled medication time
- **Conditions**:
  - ✅ User has this offset in their `notification_reminders` array
  - ✅ Medication `reminderMethod === 'E'` (Email)
  - ✅ Medication not deleted
  - ✅ Medication scheduled for today
  - ✅ Current time is within 5-minute window of (scheduled time - offset)
  - ✅ Reminder not already sent today
- **What's included**:
  - All medications with same time + offset combination
  - Note about when the actual dose is scheduled
- **Frequency**: Once per medication per time per offset per day

#### 2C. **Stock Alerts** (included in reminder emails)
- **When**: Only included in `at_time` reminders at 9:00 AM
- **Types**:
  - **No Bottles**: Medication has no bottles entered
  - **Out of Stock**: Medication has `stock === 0`
- **Conditions**:
  - ✅ Medication `reminderMethod === 'E'` (Email)
  - ✅ Medication not deleted
  - ✅ It's 9:00 AM (at-time reminder)
- **Frequency**: Once per day at 9:00 AM (if no at-time reminders, sends alerts-only email)

#### 2D. **Bottle Expiration Alerts** (included in reminder emails)
- **When**: Included in all reminder emails
- **What it checks**:
  - Bottles expiring within 7 days
  - If user has alternate bottles available
- **Message**:
  - "Switch to another bottle" (if alternate available)
  - "Purchase new bottle" (if no alternate available)
- **Frequency**: Every time a reminder email is sent (if any bottles expiring)

---

## ⚠️ CONFLICTS AND WHAT HAPPENS

### Conflict 1: **Daily Agenda (9:00 AM) + At-Time Reminder (9:00 AM)**
**Scenario**: User has medication scheduled at 9:00 AM, and it's 9:00 AM
- **What happens**: 
  - ✅ Daily Agenda sends at 9:00 AM (scheduled cron)
  - ✅ At-time reminder also sends at 9:00 AM (within 5-minute window)
  - **Result**: User gets **TWO separate emails**:
    1. Daily Agenda with full schedule
    2. At-time reminder for 9:00 AM medication
- **Is this a problem?**: Potentially redundant, but both serve different purposes

### Conflict 2: **Multiple Advance Reminders for Same Medication**
**Scenario**: User has `30_minutes_before` and `at_time` enabled, medication at 10:00 AM
- **What happens**:
  - ✅ 9:30 AM: Advance reminder email sent
  - ✅ 10:00 AM: At-time reminder email sent
  - **Result**: User gets **TWO emails** for the same medication (intended behavior)

### Conflict 3: **Multiple Medications at Same Time**
**Scenario**: User has 3 medications all at 9:00 AM
- **What happens**:
  - ✅ All 3 medications grouped into **ONE combined email**
  - **Result**: Single email with all 3 medications listed

### Conflict 4: **Same Medication, Multiple Times Per Day**
**Scenario**: Medication at 9:00 AM, 3:00 PM, 9:00 PM
- **What happens**:
  - ✅ 9:00 AM: Reminder email sent
  - ✅ 3:00 PM: Reminder email sent
  - ✅ 9:00 PM: Reminder email sent
  - **Result**: **THREE separate emails** (one per time)

### Conflict 5: **Advance Reminder + At-Time Reminder Overlap**
**Scenario**: User has `5_minutes_before` and `at_time`, medication at 10:00 AM
- **What happens**:
  - ✅ 9:55 AM: 5-minute advance reminder sent
  - ✅ 10:00 AM: At-time reminder sent
  - **Result**: **TWO emails** (intended - advance warning + actual time)

### Conflict 6: **Daily Agenda + Stock Alerts at 9:00 AM**
**Scenario**: It's 9:00 AM, user has no medications at 9:00 AM but has stock alerts
- **What happens**:
  - ✅ Daily Agenda sends (if scheduled medications exist)
  - ✅ If no at-time reminders at 9:00 AM, alerts-only email sends
  - **Result**: Could be **TWO emails** if both conditions met

### Conflict 7: **Bottle Alerts in Multiple Emails**
**Scenario**: User has expiring bottles, gets reminder at 9:00 AM and 3:00 PM
- **What happens**:
  - ✅ 9:00 AM reminder: Includes bottle alerts
  - ✅ 3:00 PM reminder: Also includes bottle alerts
  - **Result**: Bottle alerts appear in **EVERY reminder email** (potentially redundant)

---

## 🔍 KEY LOGIC DETAILS

### Reminder Time Determination
1. **If user provides specific times** (`med.times` array): Use those exact times
2. **If no times provided**:
   - 1 dose/day → 9:00 AM
   - 2 doses/day → 9:00 AM, 9:00 PM
   - 3 doses/day → 9:00 AM, 3:00 PM, 9:00 PM
   - 4+ doses/day → 9:00 AM, 3:00 PM, 9:00 PM (max 3)

### Duplicate Prevention
- Uses `lastSentReminders` object with key: `${medId}|${reminderTime}|${offset}|${date}`
- Prevents sending same reminder twice in same day
- Cleans up entries older than 2 days

### Grouping Logic
- Medications with same `offset` + `reminderTime` are grouped into ONE email
- Example: 3 meds at 9:00 AM with `at_time` offset → 1 email with all 3

### Window Timing
- `WINDOW_MINUTES = 5` (5-minute window)
- Reminder sends if current time is within 5 minutes of target time
- This allows for slight timing variations in Cloud Function execution

---

## 🐛 POTENTIAL ISSUES

1. **No emails sending at all**:
   - Check: `reminderMethod === 'E'` for medications
   - Check: User has email address
   - Check: Cloud Function is deployed and running
   - Check: Email credentials configured correctly

2. **Emails sending but wrong times**:
   - Check: Timezone is `America/Los_Angeles`
   - Check: Medication times are in correct format (HH:MM)
   - Check: `shouldSendReminderToday()` logic (day of week, end date)

3. **Duplicate emails**:
   - Check: `lastSentReminders` tracking
   - Check: Cloud Function running too frequently (should be every 1 minute)

4. **Missing advance reminders**:
   - Check: User's `notification_reminders` array in profile
   - Check: `shouldSendOffsetReminder()` logic
   - Check: Window timing (5-minute window might be too narrow)

5. **Bottle alerts not showing**:
   - Check: Bottle format in Firebase (should be "MM/DD/YYYY/quantity")
   - Check: `getBottleAlertsForUser()` function
   - Check: Expiration threshold (7 days)

---

## 📊 SUMMARY TABLE

| Email Type | Frequency | When | Includes | Conflicts With |
|------------|-----------|------|----------|----------------|
| Daily Agenda | Once/day | 9:00 AM | Full schedule + bottle alerts | At-time reminders at 9:00 AM |
| At-Time Reminder | Per medication per time | At scheduled time | Medication + schedule + alerts (if 9 AM) | Daily Agenda if at 9:00 AM |
| Advance Reminder | Per medication per offset | Before scheduled time | Medication + offset note | None (intended) |
| Stock Alerts | Once/day | 9:00 AM only | No bottles/out of stock | Daily Agenda |
| Bottle Alerts | Every reminder | All reminders | Expiring bottles | None (included in all) |

