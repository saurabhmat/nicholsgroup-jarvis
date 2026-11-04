// Lane types. The lane router (T-016) lives here later.
// Lane ids come from the database / lane_config, never from a hard-coded list.
export type LaneId = string;

/** A lane the signed-in user may open: its code (the lane id) and display name from the lane record (core.lanes). */
export type LaneSummary = { laneId: LaneId; name: string };
