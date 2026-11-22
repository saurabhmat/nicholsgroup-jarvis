// Windows time zone names -> IANA names, for the all-day events of the Microsoft calendar sync (T-067, spec §9, V-18).
//
// OUR OWN ASSUMPTION, not Microsoft's: Microsoft returns Windows zone names ("Pacific Standard Time") in `originalStartTimeZone` and documents NO
// mapping to IANA names (docs/plan-review.md, "T-067: spec §15 verify items", V-18). The pairs below follow the commonly used CLDR "windowsZones"
// territory 001 choices, written down by hand and covering the common zones only. A test proves every IANA name here is one Node's `Intl` knows
// (no dead entries); it cannot prove that a pair is what Microsoft means, which is a live check (H-070).
//
// An all-day event whose zone is NOT in this table (or is `tzone://Microsoft/Custom`, or is missing) is skipped and counted by the caller, never
// guessed. Timed events do not need this table: they arrive in UTC because of `Prefer: outlook.timezone="UTC"`.
const PAIRS: readonly (readonly [string, string])[] = [
  // UTC and GMT
  ["UTC", "UTC"],
  ["GMT Standard Time", "Europe/London"],
  ["Greenwich Standard Time", "Atlantic/Reykjavik"],
  // United States (including Alaska, Hawaii, Arizona and Indiana) and Canada
  ["Eastern Standard Time", "America/New_York"],
  ["US Eastern Standard Time", "America/Indiana/Indianapolis"],
  ["Central Standard Time", "America/Chicago"],
  ["Mountain Standard Time", "America/Denver"],
  ["US Mountain Standard Time", "America/Phoenix"],
  ["Pacific Standard Time", "America/Los_Angeles"],
  ["Alaskan Standard Time", "America/Anchorage"],
  ["Aleutian Standard Time", "America/Adak"],
  ["Hawaiian Standard Time", "Pacific/Honolulu"],
  ["Atlantic Standard Time", "America/Halifax"],
  ["Newfoundland Standard Time", "America/St_Johns"],
  ["Canada Central Standard Time", "America/Regina"],
  // Mexico, Central and South America
  ["Mexico Standard Time", "America/Mexico_City"],
  ["Pacific Standard Time (Mexico)", "America/Tijuana"],
  ["Central America Standard Time", "America/Guatemala"],
  ["SA Pacific Standard Time", "America/Bogota"],
  ["SA Western Standard Time", "America/La_Paz"],
  ["SA Eastern Standard Time", "America/Cayenne"],
  ["E. South America Standard Time", "America/Sao_Paulo"],
  ["Argentina Standard Time", "America/Argentina/Buenos_Aires"],
  // Europe
  ["W. Europe Standard Time", "Europe/Berlin"],
  ["Central Europe Standard Time", "Europe/Budapest"],
  ["Central European Standard Time", "Europe/Warsaw"],
  ["Romance Standard Time", "Europe/Paris"],
  ["GTB Standard Time", "Europe/Bucharest"],
  ["FLE Standard Time", "Europe/Kiev"],
  ["E. Europe Standard Time", "Europe/Chisinau"],
  ["Russian Standard Time", "Europe/Moscow"],
  ["Turkey Standard Time", "Europe/Istanbul"],
  // Middle East and Africa
  ["Israel Standard Time", "Asia/Jerusalem"],
  ["Middle East Standard Time", "Asia/Beirut"],
  ["Arab Standard Time", "Asia/Riyadh"],
  ["Arabian Standard Time", "Asia/Dubai"],
  ["Iran Standard Time", "Asia/Tehran"],
  ["Egypt Standard Time", "Africa/Cairo"],
  ["South Africa Standard Time", "Africa/Johannesburg"],
  ["W. Central Africa Standard Time", "Africa/Lagos"],
  ["E. Africa Standard Time", "Africa/Nairobi"],
  // South and Southeast Asia
  ["India Standard Time", "Asia/Kolkata"],
  ["Sri Lanka Standard Time", "Asia/Colombo"],
  ["Nepal Standard Time", "Asia/Kathmandu"],
  ["Pakistan Standard Time", "Asia/Karachi"],
  ["Bangladesh Standard Time", "Asia/Dhaka"],
  ["SE Asia Standard Time", "Asia/Bangkok"],
  ["Singapore Standard Time", "Asia/Singapore"],
  // East Asia
  ["China Standard Time", "Asia/Shanghai"],
  ["Taipei Standard Time", "Asia/Taipei"],
  ["Tokyo Standard Time", "Asia/Tokyo"],
  ["Korea Standard Time", "Asia/Seoul"],
  // Australia and New Zealand
  ["AUS Eastern Standard Time", "Australia/Sydney"],
  ["E. Australia Standard Time", "Australia/Brisbane"],
  ["Tasmania Standard Time", "Australia/Hobart"],
  ["Cen. Australia Standard Time", "Australia/Adelaide"],
  ["AUS Central Standard Time", "Australia/Darwin"],
  ["W. Australia Standard Time", "Australia/Perth"],
  ["New Zealand Standard Time", "Pacific/Auckland"],
];

const BY_NAME: ReadonlyMap<string, string> = new Map(PAIRS.map(([windows, iana]) => [windows.toLowerCase(), iana]));

/** The table itself (for the tests that check it has no dead entries and no duplicates). */
export const WINDOWS_ZONE_PAIRS: readonly (readonly [string, string])[] = PAIRS;

/** The `EventMeta` timezone rule (comms/schemas.ts). */
const IANA_SHAPE = /^[A-Za-z0-9_+./-]{1,64}$/;

/**
 * The IANA name for a zone name: the Windows table first (case-insensitive); otherwise a name that already IS an IANA zone (Microsoft says such names can
 * appear, and the table does not cover every region), accepted only when `Intl` knows it and it fits the `EventMeta` rule. Null for anything else
 * (`tzone://Microsoft/Custom`, unknown Windows names, empty, non-strings). The caller's local-midnight check still guards the result. Never guesses.
 */
export function ianaForWindowsZone(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0 || name.length > 100) return null;
  const mapped = BY_NAME.get(name.toLowerCase());
  if (mapped) return mapped;
  if (!IANA_SHAPE.test(name)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone === undefined ? null : name;
  } catch {
    return null;
  }
}
