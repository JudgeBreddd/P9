// A stand-in for the Claude Agent SDK's query, for the live Claude usage poll (main.mjs --usage-sdk): 37% of the 5 h
// window and 63% of the week.
const USAGE_CALL = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';
export const query = () => ({
  [USAGE_CALL]: async () => ({ rate_limits_available: true, rate_limits: {
    five_hour: { utilization: 37, resets_at: new Date(Date.now() + 2 * 3600e3).toISOString() },
    seven_day: { utilization: 63, resets_at: new Date(Date.now() + 4 * 86400e3).toISOString() } } }),
  close() {},
});
