/**
 * Tag diff domain model.
 *
 * Represents the delta between desired tags (from VMware)
 * and current tags (on a Vision One device).
 */

import { DeviceMatch } from './EndpointMatch';

export interface TagDiff {
  deviceMatch: DeviceMatch;
  tagsToAdd: string[];
  tagsToRemove: string[];
}
