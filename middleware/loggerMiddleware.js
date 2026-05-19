export const requestLogger = (req, res, next) => {
  const startTime = process.hrtime();

  res.on("finish", () => {
    const elapsedHrTime = process.hrtime(startTime);
    const elapsedTimeInMs = (elapsedHrTime[0] * 1000 + elapsedHrTime[1] / 1e6).toFixed(2);
    
    const { method, originalUrl } = req;
    const { statusCode } = res;

    // ANSI Color Codes
    const reset = "\x1b[0m";
    const magenta = "\x1b[35m";
    const gray = "\x1b[90m";
    
    let statusColor = "\x1b[32m"; // Green for 2xx
    if (statusCode >= 500) {
      statusColor = "\x1b[31m"; // Red for 5xx
    } else if (statusCode >= 400) {
      statusColor = "\x1b[33m"; // Yellow for 4xx
    } else if (statusCode >= 300) {
      statusColor = "\x1b[36m"; // Cyan for 3xx
    }

    console.log(
      `${gray}[${new Date().toISOString()}]${reset} ${magenta}${method}${reset} ${originalUrl} - ${statusColor}${statusCode}${reset} ${gray}(${elapsedTimeInMs}ms)${reset}`
    );
  });

  next();
};
