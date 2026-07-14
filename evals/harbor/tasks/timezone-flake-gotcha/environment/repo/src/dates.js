// schedcore — day formatting.
// formatDay returns the calendar day of an instant as "YYYY-MM-DD".
export function formatDay(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
