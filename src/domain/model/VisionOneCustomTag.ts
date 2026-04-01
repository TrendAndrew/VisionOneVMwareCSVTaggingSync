/**
 * Vision One custom tag domain model.
 *
 * Custom tags in Vision One are key-value pairs that can be
 * assigned to devices for grouping and policy assignment.
 * Tags must be pre-created in the Vision One console.
 */

export interface VisionOneCustomTag {
  /** Unique tag identifier used in API calls. */
  tagId: string;
  /** Tag property/category (e.g., "Environment"). */
  key: string;
  /** Tag value (e.g., "Production"). */
  value: string;
}
