/** Current time as a Unix epoch in seconds (not milliseconds). */
export function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}