// How the attention window reads on screen (T-240): lane_config briefing.attention.fresh_hours as words. 48 -> "2 days", 24 -> "24 hours",
// 36 -> "36 hours", 168 -> "7 days". Whole days from 48 hours up, hours below that.
export function freshWindowText(hours: number): string {
  const h = Math.max(1, Math.round(hours));
  return h >= 48 && h % 24 === 0 ? `${String(h / 24)} days` : `${String(h)} hours`;
}
