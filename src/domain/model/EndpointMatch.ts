/**
 * Device match domain model.
 *
 * Represents a successful match between a VMware VM and a
 * Vision One device, including how the match was established.
 */

import { VmwareVm } from './VmwareVm';
import { VisionOneDevice } from './VisionOneEndpoint';
import { MatchedOn, MatchConfidence } from '../../shared/types';

export interface DeviceMatch {
  vmwareVm: VmwareVm;
  visionOneDevice: VisionOneDevice;
  matchedOn: MatchedOn;
  confidence: MatchConfidence;
}
