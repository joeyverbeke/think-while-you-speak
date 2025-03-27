function timeLog(message, startTime) {
    const elapsed = startTime ? ((Date.now() - startTime) / 1000).toFixed(2) : 0;
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}${startTime ? ` (${elapsed}s)` : ''}`);
    return Date.now();
}

module.exports = {
    timeLog
}; 