import fs from 'fs/promises';

const CONFIG_FILE = './config.json';

async function viewHistory() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(data);
    
    if (config.history.length === 0) {
      console.log('No history yet');
      return;
    }
    
    console.log(`📜 History (${config.history.length} entries):\n`);
    
    config.history.forEach((entry, index) => {
      const date = new Date(entry.date);
      const dateStr = date.toLocaleDateString('en-US', { 
        weekday: 'short', 
        month: 'short', 
        day: 'numeric',
        year: 'numeric'
      });
      
      if (entry.cancelled) {
        console.log(`${index + 1}. ${dateStr} - ❌ CANCELLED (${entry.attendees} attendees)`);
      } else {
        console.log(`${index + 1}. ${dateStr} - ${entry.leader} led on "${entry.topic}" (${entry.attendees} attendees)`);
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
  }
}

viewHistory();
