/**
 * Unmatched report writer.
 *
 * After each sync cycle, writes a report listing all VMs and devices
 * that could not be matched. Produces both a machine-readable JSON file
 * and a human-readable TXT file that suggests mapping overrides.
 */

import fs from 'fs/promises';
import path from 'path';
import { VmwareVm } from '../../domain/model/VmwareVm';
import { VisionOneDevice } from '../../domain/model/VisionOneEndpoint';
import { DeviceMatch } from '../../domain/model/EndpointMatch';

export interface UnmatchedVmEntry {
  vmId: string;
  name: string;
  sourceVcenter?: string;
  guestHostname: string | null;
  ipAddresses: string[];
  tags: string[];
  reason: string;
}

export interface UnmatchedDeviceEntry {
  deviceId: string;
  deviceName: string;
  ipAddresses: string[];
}

export interface UnmatchedReport {
  timestamp: string;
  unmatchedVms: UnmatchedVmEntry[];
  unmatchedDevices: UnmatchedDeviceEntry[];
  matchedCount: number;
  totalVms: number;
  totalDevices: number;
}

export class UnmatchedReporter {
  constructor(
    private readonly reportPath: string = './data/unmatched-report.json'
  ) {}

  /**
   * Compute unmatched VMs and devices, then write JSON and TXT reports.
   *
   * @param allVms - All VMs fetched from VMware.
   * @param allDevices - All devices fetched from Vision One.
   * @param matches - Successfully matched VM-device pairs.
   * @returns The unmatched report data.
   */
  async writeReport(
    allVms: VmwareVm[],
    allDevices: VisionOneDevice[],
    matches: DeviceMatch[]
  ): Promise<UnmatchedReport> {
    const matchedVmIds = new Set(matches.map((m) => m.vmwareVm.vmId));
    const matchedDeviceIds = new Set(
      matches.map((m) => m.visionOneDevice.id)
    );

    const unmatchedVms: UnmatchedVmEntry[] = allVms
      .filter((vm) => !matchedVmIds.has(vm.vmId))
      .map((vm) => ({
        vmId: vm.vmId,
        name: vm.name,
        sourceVcenter: vm.sourceVcenter,
        guestHostname: vm.guestHostname,
        ipAddresses: vm.ipAddresses,
        tags: vm.tags.map((t) =>
          t.categoryName ? `${t.categoryName}/${t.name}` : t.name
        ),
        reason: this.diagnoseUnmatchedVm(vm, allDevices),
      }));

    const unmatchedDevices: UnmatchedDeviceEntry[] = allDevices
      .filter((d) => !matchedDeviceIds.has(d.id))
      .map((d) => ({
        deviceId: d.id,
        deviceName: d.deviceName,
        ipAddresses: d.ipAddresses,
      }));

    const report: UnmatchedReport = {
      timestamp: new Date().toISOString(),
      unmatchedVms,
      unmatchedDevices,
      matchedCount: matches.length,
      totalVms: allVms.length,
      totalDevices: allDevices.length,
    };

    await this.ensureDirectory();
    await this.writeJsonReport(report);
    await this.writeTxtReport(report, matches);

    return report;
  }

  /**
   * Diagnose why a VM could not be matched.
   */
  private diagnoseUnmatchedVm(
    vm: VmwareVm,
    allDevices: VisionOneDevice[]
  ): string {
    const hasHostname = vm.guestHostname !== null && vm.guestHostname !== '';
    const hasIps = vm.ipAddresses.length > 0;

    if (!hasHostname && !hasIps) {
      return 'No guest hostname or IP addresses available (VMware Tools may not be installed)';
    }

    if (!hasHostname) {
      return 'No guest hostname available; IP-only matching may be unreliable';
    }

    if (!hasIps) {
      return 'No IP addresses available; hostname-only matching was attempted';
    }

    // Check if there's a partial hostname match
    const normalizedVm = (vm.guestHostname ?? vm.name)
      .split('.')[0]
      .toLowerCase();
    const partialMatches = allDevices.filter((d) => {
      const normalizedDev = d.deviceName.split('.')[0].toLowerCase();
      return (
        normalizedDev.includes(normalizedVm) ||
        normalizedVm.includes(normalizedDev)
      );
    });

    if (partialMatches.length > 0) {
      const names = partialMatches
        .slice(0, 3)
        .map((d) => d.deviceName)
        .join(', ');
      return `Possible partial hostname matches found: ${names}`;
    }

    return 'No matching device found by hostname or IP';
  }

  /**
   * Write the JSON report file.
   */
  private async writeJsonReport(report: UnmatchedReport): Promise<void> {
    const resolvedPath = path.resolve(this.reportPath);
    const json = JSON.stringify(report, null, 2);
    await fs.writeFile(resolvedPath, json, 'utf-8');
  }

  /**
   * Write a human-readable TXT report with suggested mapping overrides.
   */
  private async writeTxtReport(report: UnmatchedReport, matches: DeviceMatch[] = []): Promise<void> {
    const txtPath = path.resolve(
      this.reportPath.replace('.json', '.txt')
    );

    const lines: string[] = [];

    lines.push('='.repeat(72));
    lines.push('UNMATCHED VM & DEVICE REPORT');
    lines.push(`Generated: ${report.timestamp}`);
    lines.push('='.repeat(72));
    lines.push('');
    lines.push(
      `Summary: ${report.matchedCount} matched | ` +
        `${report.unmatchedVms.length} unmatched VMs | ` +
        `${report.unmatchedDevices.length} unmatched devices | ` +
        `${report.totalVms} total VMs | ` +
        `${report.totalDevices} total devices`
    );
    lines.push('');

    if (report.unmatchedVms.length > 0) {
      lines.push('-'.repeat(72));
      lines.push('UNMATCHED VMs');
      lines.push('-'.repeat(72));

      for (const vm of report.unmatchedVms) {
        lines.push('');
        lines.push(`  VM ID:     ${vm.vmId}`);
        lines.push(`  Name:      ${vm.name}`);
        if (vm.sourceVcenter) {
          lines.push(`  vCenter:   ${vm.sourceVcenter}`);
        }
        lines.push(`  Hostname:  ${vm.guestHostname ?? '(none)'}`);
        lines.push(
          `  IPs:       ${vm.ipAddresses.length > 0 ? vm.ipAddresses.join(', ') : '(none)'}`
        );
        lines.push(
          `  Tags:      ${vm.tags.length > 0 ? vm.tags.join(', ') : '(none)'}`
        );
        lines.push(`  Reason:    ${vm.reason}`);
      }

      lines.push('');
    }

    if (report.unmatchedDevices.length > 0) {
      lines.push('-'.repeat(72));
      lines.push('UNMATCHED DEVICES');
      lines.push('-'.repeat(72));

      for (const d of report.unmatchedDevices) {
        lines.push('');
        lines.push(`  Device ID: ${d.deviceId}`);
        lines.push(`  Name:      ${d.deviceName}`);
        lines.push(
          `  IPs:       ${d.ipAddresses.length > 0 ? d.ipAddresses.join(', ') : '(none)'}`
        );
      }

      lines.push('');
    }

    // IP-only matches (for review)
    const ipOnlyMatches = matches.filter(m => m.matchedOn === 'ip');
    if (ipOnlyMatches.length > 0) {
      lines.push('-'.repeat(72));
      lines.push('IP-ONLY MATCHES (review recommended)');
      lines.push('-'.repeat(72));
      lines.push('');
      lines.push('These VMs were matched to devices by IP address only (no hostname');
      lines.push('match). Consider adding manual overrides to confirm these mappings.');
      lines.push('');

      for (const m of ipOnlyMatches) {
        lines.push(`  VM:     ${m.vmwareVm.name} (${m.vmwareVm.vmId})`);
        lines.push(`  Device: ${m.visionOneDevice.deviceName} (${m.visionOneDevice.id})`);
        lines.push(`  IPs:    ${m.vmwareVm.ipAddresses.join(', ')}`);
        lines.push('');
      }
    }

    // Suggest mapping overrides
    if (report.unmatchedVms.length > 0) {
      lines.push('-'.repeat(72));
      lines.push('SUGGESTED MAPPING OVERRIDES');
      lines.push('-'.repeat(72));
      lines.push('');
      lines.push(
        'To manually map unmatched VMs to devices, add entries to'
      );
      lines.push(
        'config/mapping-overrides.json in the "overrides" array:'
      );
      lines.push('');

      for (const vm of report.unmatchedVms) {
        lines.push(`  {`);
        lines.push(`    "vmId": "${vm.vmId}",`);
        lines.push(`    "vmName": "${vm.name}",`);
        lines.push(`    "deviceId": "<PASTE_DEVICE_ID_HERE>",`);
        lines.push(
          `    "comment": "Manual override for ${vm.name}"`
        );
        lines.push(`  }`);
        lines.push('');
      }

      lines.push(
        'After editing, send SIGHUP to the process to reload without restart:'
      );
      lines.push('  kill -HUP <pid>');
      lines.push('');
    }

    await fs.writeFile(txtPath, lines.join('\n'), 'utf-8');
  }

  /**
   * Ensure the output directory exists.
   */
  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(path.resolve(this.reportPath));
    await fs.mkdir(dir, { recursive: true });
  }
}
