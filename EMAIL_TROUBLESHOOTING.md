# Email Troubleshooting Checklist

## ✅ What to Check

### 1. **Medication Requirements**
Your medication MUST have:
- ✅ `reminderMethod: 'E'` (Email) - Check in Firebase
- ✅ Scheduled for TODAY's day of week
- ✅ `endDate` is in the future (or 'N/A')
- ✅ `deletedStatus: false` (or undefined)
- ✅ At least one time scheduled

### 2. **Current Dose Logic**
The system only sends emails for the **CURRENT DOSE**, not all doses:
- If you have doses at 9:00 AM and 10:00 AM
- At 6:00 AM, it will ONLY send reminders for 9:00 AM (current dose)
- After 9:45 AM (9:00 AM + 45 min buffer), it moves to 10:00 AM as current dose

### 3. **Reminder Preferences**
Check your user profile in Firebase:
- Path: `users/{userId}/notification_reminders`
- Should be an array like: `["30_minutes_before", "at_time"]`
- If empty, defaults to: `["30_minutes_before", "at_time"]`

### 4. **Email Configuration**
Verify email is set up:
```bash
firebase functions:config:get
```
Should show:
- `gmail.email` - Your Gmail address
- `gmail.password` - Your Gmail App Password (not regular password)

### 5. **Function Deployment**
Make sure function is deployed:
```bash
firebase deploy --only functions:sendMedicationReminders
```

### 6. **Check Logs**
View recent logs:
```bash
firebase functions:log | tail -100
```

Look for:
- `=== Checking medication: [Name] ===` - New detailed logging
- `-> PASSED: Email reminders enabled` - Medication passed checks
- `-> Current dose: [time], dose #X` - Current dose determined
- `Queued [medication] for [time]` - Reminder queued
- `email sent` - Email actually sent

## 🔍 Common Issues

### Issue: "Not scheduled for [day]"
**Fix**: Make sure medication's `daysOfWeek` includes today's day

### Issue: "End date has passed"
**Fix**: Update `endDate` to future date or set to 'N/A'

### Issue: "Reminder method is not Email"
**Fix**: Set `reminderMethod: 'E'` in Firebase

### Issue: "No current dose found"
**Fix**: Check that medication has valid times and is scheduled for today

### Issue: "Too early for [time]"
**Fix**: This is normal - reminders only send within 5-minute window

## 📝 Test Medication Setup

Create a test medication with:
```json
{
  "name": "Test Email Med",
  "reminderMethod": "E",
  "daysOfWeek": ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
  "times": ["14:00"],  // 2:00 PM - easy to test
  "timesPerDay": 1,
  "endDate": "N/A",
  "deletedStatus": false
}
```

Then wait for 1:30 PM (30 min before) or 2:00 PM (at time) to see if email sends.

## 🚨 Still Not Working?

1. Check Cloud Function logs for errors
2. Verify Gmail App Password is correct (not regular password)
3. Check spam folder
4. Verify user email address in Firebase is correct
5. Make sure function is running (check logs show "Starting medication reminder check...")

