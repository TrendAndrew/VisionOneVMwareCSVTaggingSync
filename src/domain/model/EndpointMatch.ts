/**
 * Endpoint match domain model.
 *
 * Represents a successful match between a VMware VM and a
 * Vision One endpoint, including how the match was established.
 */

import { VmwareVm } from './VmwareVm';
import { VisionOneEndpoint } from './VisionOneEndpoint';
import { MatchedOn, MatchConfidence } from '../../shared/types';

export interface EndpointMatch {
  vmwareVm: VmwareVm;
  visionOneEndpoint: VisionOneEndpoint;
  matchedOn: MatchedOn;
  confidence: MatchConfidence;
}
