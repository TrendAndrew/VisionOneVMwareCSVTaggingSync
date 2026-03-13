/**
 * Tag diff domain model.
 *
 * Represents the delta between desired tags (from VMware)
 * and current tags (on a Vision One endpoint).
 */

import { EndpointMatch } from './EndpointMatch';

export interface TagDiff {
  endpointMatch: EndpointMatch;
  tagsToAdd: string[];
  tagsToRemove: string[];
}
