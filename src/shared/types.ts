/**
 * Shared type definitions for VMware-to-Vision One tag synchronization.
 */

/** Strategy used to match VMware VMs to Vision One endpoints. */
export type MatchStrategy = 'hostname' | 'ip' | 'hostname-then-ip' | 'compound';

/** How hostnames are normalized before comparison. */
export type HostnameNormalization = 'lowercase-no-domain' | 'lowercase' | 'exact';

/** Which IP addresses to consider when matching. */
export type IpMatchMode = 'any' | 'primary';

/** Confidence level of a match result. */
export type MatchConfidence = 'exact' | 'normalized';

/** Which identifier was used to establish the match. */
export type MatchedOn = 'hostname' | 'ip' | 'both';

/** Application log levels. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** VMware virtual machine power state. */
export type PowerState = 'POWERED_ON' | 'POWERED_OFF' | 'SUSPENDED';
