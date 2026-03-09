/**
 * Test script for medication reminder logic
 * Run this locally to test the reminder calculation without deploying
 * 
 * Usage: node test-reminders.js
 */

// Sample medications for testing
const testMedications = [
  {
    id: 'test1',
    name: 'Aspirin',
    dosage: 100,
    daysOfWeek: ['monday', 'wednesday', 'friday'],
    timesPerDay: 2,
    times: ['08:00', '20:00'], // Custom times
    reminderMethod: 'E',
    deletedStatus: false,
    endDate: '12/31/2025',
    stock: 2
  },
  {
    id: 'test2',
    name: 'Vitamin D',
    dosage: 1000,
    daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    timesPerDay: 1,
    times: [], // No custom times - should default to 9 AM
    reminderMethod: 'E',
    deletedStatus: false,
    endDate: 'N/A',
    stock: 1
  },
  {
    id: 'test3',
    name: 'Blood Pressure Med',
    dosage: 50,
    daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    timesPerDay: 3,
    times: [], // No custom times - should use 9 AM, 3 PM, 9 PM
    reminderMethod: 'E',
    deletedStatus: false,
    endDate: 'N/A',
    stock: 1
  },
  {
    id: 'test4',
    name: 'Deleted Med',
    dosage: 25,
    daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    timesPerDay: 1,
    times: [],
    reminderMethod: 'E',
    deletedStatus: true, // DELETED - should NOT send
    endDate: 'N/A',
    stock: 0
  },
  {
    id: 'test5',
    name: 'Expired Med',
    dosage: 10,
    daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    timesPerDay: 1,
    times: [],
    reminderMethod: 'E',
    deletedStatus: false,
    endDate: '01/01/2024', // EXPIRED - should NOT send
    stock: 1
  },
  {
    id: 'test6',
    name: 'SMS Reminder',
    dosage: 5,
    daysOfWeek: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
    timesPerDay: 1,
    times: [],
    reminderMethod: 'S', // SMS not EMAIL - should NOT send
    deletedStatus: false,
    endDate: 'N/A',
    stock: 1
  },
  {
    id: 'test7',
    name: 'Weekend Only Med',
    dosage: 200,
    daysOfWeek: ['saturday', 'sunday'],
    timesPerDay: 1,
    times: ['10:00'],
    reminderMethod: 'E',
    deletedStatus: false,
    endDate: 'N/A',
    stock: 3
  }
];

// Copy the logic from index.js
function getReminderTimes(med) {
  if (med.times && med.times.length > 0) {
    return med.times;
  }
  
  const timesPerDay = med.timesPerDay || 1;
  
  if (timesPerDay === 1) {
    return ['09:00'];
  } else if (timesPerDay === 2) {
    return ['09:00', '21:00'];
  } else if (timesPerDay === 3) {
    return ['09:00', '15:00', '21:00'];
  } else if (timesPerDay > 3) {
    return ['09:00', '15:00', '21:00'];
  }
  
  return ['09:00'];
}

function shouldSendReminderToday(med) {
  const today = new Date();
  const todayDay = today.getDay();
  const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const todayName = weekdays[todayDay];
  
  if (med.deletedStatus === true) {
    return false;
  }
  
  if (med.endDate && med.endDate !== 'N/A') {
    try {
      const endDate = new Date(med.endDate);
      endDate.setHours(23, 59, 59, 999);
      if (today > endDate) {
        return false;
      }
    } catch (e) {
      console.error('Error parsing end date:', med.endDate);
    }
  }
  
  if (med.daysOfWeek && med.daysOfWeek.length > 0) {
    const todaySelected = med.daysOfWeek.some(day => 
      day.toLowerCase() === todayName
    );
    if (!todaySelected) {
      return false;
    }
  }
  
  return true;
}

function format12Hour(time24) {
  const [hours, minutes] = time24.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${hour12}:${minutes.toString().padStart(2, '0')} ${ampm}`;
}

// Test function
function testReminderLogic() {
  const today = new Date();
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const todayName = weekdays[today.getDay()];
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Everane Reminder Logic Test');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Today: ${todayName}, ${today.toLocaleDateString()}`);
  console.log('═══════════════════════════════════════════════════════════\n');
  
  testMedications.forEach(med => {
    console.log(`\n📋 ${med.name}`);
    console.log('─────────────────────────────────────────────────────────');
    
    // Check if reminder should be sent
    const shouldSend = shouldSendReminderToday(med);
    const reminderTimes = getReminderTimes(med);
    const hasCustomTimes = med.times && med.times.length > 0;
    
    console.log(`  Reminder Method: ${med.reminderMethod === 'E' ? 'Email ✅' : med.reminderMethod === 'S' ? 'SMS ❌' : 'None ❌'}`);
    console.log(`  Deleted: ${med.deletedStatus ? 'Yes ❌' : 'No ✅'}`);
    console.log(`  End Date: ${med.endDate}`);
    console.log(`  Days: ${med.daysOfWeek.join(', ')}`);
    console.log(`  Times Per Day: ${med.timesPerDay}`);
    console.log(`  Custom Times: ${hasCustomTimes ? 'Yes' : 'No'}`);
    console.log(`  Stock: ${med.stock}`);
    
    if (med.reminderMethod !== 'E') {
      console.log(`\n  ❌ SKIPPED: Reminder method is not Email\n`);
      return;
    }
    
    if (!shouldSend) {
      console.log(`\n  ❌ SKIPPED: Not scheduled for today or deleted/expired\n`);
      return;
    }
    
    console.log(`\n  ✅ WILL SEND REMINDERS TODAY:`);
    reminderTimes.forEach(time => {
      const time12 = format12Hour(time);
      console.log(`     • ${time12} (${time})`);
      if (hasCustomTimes) {
        console.log(`       + 30-min advance at ${format12Hour(subtractMinutes(time, 30))}`);
      }
    });
    console.log('');
  });
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('═══════════════════════════════════════════════════════════');
  
  const totalMeds = testMedications.length;
  const activeMeds = testMedications.filter(m => 
    m.reminderMethod === 'E' && shouldSendReminderToday(m)
  ).length;
  const totalReminders = testMedications
    .filter(m => m.reminderMethod === 'E' && shouldSendReminderToday(m))
    .reduce((sum, m) => sum + getReminderTimes(m).length, 0);
  const advance30Min = testMedications
    .filter(m => m.reminderMethod === 'E' && shouldSendReminderToday(m) && m.times && m.times.length > 0)
    .reduce((sum, m) => sum + m.times.length, 0);
  
  console.log(`  Total medications: ${totalMeds}`);
  console.log(`  Active today: ${activeMeds}`);
  console.log(`  Total email reminders: ${totalReminders}`);
  console.log(`  30-min advance reminders: ${advance30Min}`);
  console.log(`  Total emails today: ${totalReminders + advance30Min}`);
  console.log('═══════════════════════════════════════════════════════════\n');
}

function subtractMinutes(time24, minutes) {
  const [hours, mins] = time24.split(':').map(Number);
  const totalMins = hours * 60 + mins - minutes;
  const newHours = Math.floor(totalMins / 60) % 24;
  const newMins = totalMins % 60;
  return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
}

// Run the test
testReminderLogic();

