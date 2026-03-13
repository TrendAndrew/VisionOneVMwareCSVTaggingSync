/**
 * Tag mapping domain model.
 *
 * Defines how a VMware category/tag pair maps to a
 * Vision One custom tag name during synchronization.
 */

export interface TagMapping {
  vmwareCategoryName: string;
  vmwareTagName: string;
  visionOneTagName: string;
}
