// Gaps longer than this between two activity timestamps count as idle, not active time. Shared by
// the delta engine (segment duration) and the session timeline (idle classification) so both
// classify "working" against the exact same threshold.
export const IDLE_GAP_SEC = 300;
