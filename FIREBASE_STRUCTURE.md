# Firebase Structure Documentation

## Medication Document Structure

Each medication document in `users/{userId}/medications/{medId}` has the following structure:

### Required Fields:
- `name` (string): Medication name
- `dosage` (number): Dosage amount
- `daysOfWeek` (array): Days of week medication is taken (e.g., ["Monday", "Wednesday"])
- `timesPerDay` (number): Number of doses per day
- `times` (array): Array of time strings in "HH:MM" format, sorted chronologically
- `startDate` (string): Start date in "M/d/yyyy" format (or "N/A")
- `endDate` (string): End date in "M/d/yyyy" format (or "N/A")
- `reminderMethod` (string): One of:
  - `'N'` = None
  - `'E'` = Email only
  - `'S'` = SMS only
  - `'ES'` = Email + SMS
- `stock` (number): Number of bottles
- `bottles` (array): Array of strings in format "M/d/yyyy/quantity" (e.g., "12/31/2024/100")
- `deletedStatus` (boolean): `false` for active medications, `true` for deleted
- `notes` (object): Map of date strings to dose notes: `{ "M/d/yyyy": { "1": "note text", "2": "note text" } }`
- `doses` (object): **CURRENT STRUCTURE** - Map of dose entries:
  ```
  {
    "YYYY-MM-DD_doseNumber": {
      date: "YYYY-MM-DD",
      doseNumber: number,
      taken: boolean,
      takenAt: string (ISO timestamp) or null,
      autoMarked: boolean (optional, true if auto-marked as missed)
    }
  }
  ```
  Example: `{ "2024-12-15_1": { date: "2024-12-15", doseNumber: 1, taken: true, takenAt: "2024-12-15T14:30:00.000Z" } }`

### Optional Fields:
- `createdAt` (string): ISO timestamp of when medication was created
- `updatedAt` (string): ISO timestamp of last update
- `id` (string): Medication ID (usually same as document ID)

### DEPRECATED FIELDS (Should be deleted):
- ❌ `doseStatus` - **DO NOT USE** - This field is automatically deleted when medications are saved/updated
- ❌ `doseHistory` - **DO NOT USE** - This field is automatically deleted when medications are saved/updated

## Dose Entry Structure

Each dose entry in the `doses` object uses the key format: `"YYYY-MM-DD_doseNumber"`

**Key Format:**
- Date: `YYYY-MM-DD` (ISO date format, local timezone)
- Dose Number: Integer starting from 1
- Example: `"2024-12-15_1"` = First dose on December 15, 2024

**Value Structure:**
```javascript
{
  date: "2024-12-15",        // Same as date in key
  doseNumber: 1,              // Same as dose number in key
  taken: true,                // boolean: true = taken, false = not taken
  takenAt: "2024-12-15T14:30:00.000Z",  // ISO timestamp when marked as taken, or null
  autoMarked: true            // Optional: true if auto-marked as missed by Cloud Function
}
```

## Firebase Operations

### 1. Saving Doses (home.html, calendar.html)
- **Location**: `saveDoseToFirebase()` in `home.html`, `saveDose()` in `calendar.html`
- **Operation**: `setDoc(medDocRef, updateData, { merge: true })`
- **Updates**: 
  - Updates `doses` object with new/updated dose entry
  - Updates `bottles` array (stock management)
  - **Deletes** `doseStatus` and `doseHistory` if they exist

### 2. Creating New Medication (add-medication.html)
- **Location**: New medication flow
- **Operation**: `addDoc(medicationsCollectionRef, medData)`
- **Creates**: New document with `doses: {}` (empty object)
- **Does NOT create**: `doseStatus` or `doseHistory`

### 3. Editing Medication (add-medication.html)
- **Location**: Edit flow (`editIdx !== null`)
- **Operation**: `setDoc(medDocRef, updateData)`
- **Preserves**: 
  - `doses` (from existing data)
  - `createdAt` (from existing data)
  - `notes` (from existing data)
- **Deletes**: `doseStatus` and `doseHistory` if they exist

### 4. Renewing Medication (add-medication.html)
- **Location**: Renew flow (`renewIdx !== null`)
- **Operation**: `setDoc(medDocRef, updateData)`
- **Preserves**: 
  - `doses` (from existing data - keeps all history)
  - `createdAt` (from existing data)
  - `notes` (from existing data)
- **Sets**: `deletedStatus: false`
- **Deletes**: `doseStatus` and `doseHistory` if they exist

### 5. Auto-Marking Missed Doses (functions/index.js)
- **Location**: `checkAndMarkMissedDoses()` in Cloud Function
- **Operation**: `update.medDocRef.set({ doses: update.doses }, { merge: true })`
- **Updates**: Only the `doses` object
- **Does NOT create**: `doseStatus` or `doseHistory`
- **Does NOT delete**: `doseStatus` or `doseHistory` (client-side handles this)

### 6. Saving Medications to Firestore (home.html)
- **Location**: `saveMedicationsToFirestore()` in `home.html`
- **Operation**: `setDoc(medDocRef, updateData)`
- **Preserves**: `doses` (from existing data)
- **Deletes**: `doseStatus` and `doseHistory` if they exist

## Migration from Old Format

The code automatically migrates old array format to new object format:

**Old Format (deprecated):**
```javascript
doses: [
  { date: "2024-12-15", doseNumber: 1, taken: true },
  { date: "2024-12-15", doseNumber: 2, taken: false }
]
```

**New Format (current):**
```javascript
doses: {
  "2024-12-15_1": { date: "2024-12-15", doseNumber: 1, taken: true, takenAt: "..." },
  "2024-12-15_2": { date: "2024-12-15", doseNumber: 2, taken: false, takenAt: null }
}
```

Migration happens automatically in:
- `home.html`: `saveDoseToFirebase()` (lines 1548-1562)
- `calendar.html`: `saveDose()` (lines 1601-1613)

## Files That Handle Firebase Operations

1. **home.html**:
   - `saveDoseToFirebase()` - Saves dose status and updates stock
   - `saveMedicationsToFirestore()` - Saves medication data

2. **calendar.html**:
   - `saveDose()` - Saves dose status from calendar modal

3. **add-medication.html**:
   - Edit flow - Updates existing medication
   - Renew flow - Renews medication (sets deletedStatus: false)
   - New medication flow - Creates new medication

4. **functions/index.js**:
   - `checkAndMarkMissedDoses()` - Auto-marks missed doses
   - `sendMedicationReminders()` - Sends email reminders

## Important Notes

1. **Always use `doses` object**, never `doseStatus` or `doseHistory`
2. **Always delete** `doseStatus` and `doseHistory` when saving/updating medications
3. **Always preserve** existing `doses` when editing/renewing medications
4. **Dose keys** must be in format `"YYYY-MM-DD_doseNumber"` (date_doseNumber)
5. **Date format** in dose entries: `"YYYY-MM-DD"` (ISO date, local timezone)
6. **takenAt** is set when `taken: true`, cleared when `taken: false`
7. **autoMarked** flag is set by Cloud Function when auto-marking missed doses

