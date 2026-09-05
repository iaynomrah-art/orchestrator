import cron from 'node-cron';

// Empty function that logs when executed
function marginAnalyze() {
}

// Schedule to run every day at 00:00 PH time (UTC+8)
cron.schedule('0 0 * * *', marginAnalyze, { timezone: 'Asia/Manila' });

export { marginAnalyze };