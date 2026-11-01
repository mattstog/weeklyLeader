// Check the current wall-clock minute instead of calculating a distant next run.
// This avoids skipped Sundays across month and daylight-saving boundaries.
export function createScheduleTick(jobs, {
  timezone = 'America/Chicago',
  skipDates = [],
  onError = console.error,
} = {}) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const lastRuns = new Map();

  return async function tick(now = new Date()) {
    const parts = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    if (parts.weekday !== 'Sun' || skipDates.includes(date)) return;

    await Promise.all(jobs.map(async job => {
      if (Number(parts.hour) !== job.hour || Number(parts.minute) !== job.minute) return;
      const key = `${date}T${parts.hour}:${parts.minute}`;
      if (lastRuns.get(job) === key) return;
      lastRuns.set(job, key);
      try {
        await job.run();
      } catch (error) {
        await onError(error);
      }
    }));
  };
}

export function parseScheduleTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`Invalid schedule time: ${value}. Expected H:MM or HH:MM.`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
