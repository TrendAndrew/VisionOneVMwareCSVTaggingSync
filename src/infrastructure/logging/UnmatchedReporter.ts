/**
 * Unmatched report writer.
 *
 * After each sync cycle, writes a report listing all VMs and endpoints
 * that could not be matched. Produces both a machine-readable JSON file
 * and a human-readable TXT file that suggests mapping overrides.
 */

import fs from 'fs/promises';
import path from 'path';
import { VmwareVm } from '../../domain/model/VmwareVm';
import { VisionOneEndpoint } from '../../domain/model/VisionOneEndpoint';
import { EndpointMatch } from '../../domain/model/EndpointMatch';

export interface UnmatchedVmEntry {
  vmId: string;
  name: string;
  guestHostname: string | null;
  ipAddresses: string[];
  tags: string[];
  reason: string;
}

export interface UnmatchedEndpointEntry {
  agentGuid: string;
  endpointName: string;
  ipAddresses: string[];
}

export interface UnmatchedReport {
  timestamp: string;
  unmatchedVms: UnmatchedVmEntry[];
  unmatchedEndpoints: UnmatchedEndpointEntry[];
  matchedCount: number;
  totalVms: number;
  totalEndpoints: number;
}

export class UnmatchedReporter {
  constructor(
    private readonly reportPath: string = './data/unmatched-report.json'
  ) {}

  /**
   * Compute unmatched VMs and endpoints, then write JSON and TXT reports.
   *
   * @param allVms - All VMs fetched from VMware.
   * @param allEndpoints - All endpoints fetched from Vision One.
   * @param matches - Successfully matched VM-endpoint pairs.
   * @returns The unmatched report data.
   */
  async writeReport(
    allVms: VmwareVm[],
    allEndpoints: VisionOneEndpoint[],
    matches: EndpointMatch[]
  ): Promise<UnmatchedReport> {
    const matchedVmIds = new Set(matches.map((m) => m.vmwareVm.vmId));
    const matchedEndpointGuids = new Set(
      matches.map((m) => m.visionOneEndpoint.agentGuid)
    );

    const unmatchedVms: UnmatchedVmEntry[] = allVms
      .filter((vm) => !matchedVmIds.has(vm.vmId))
      .map((vm) => ({
        vmId: vm.vmId,
        name: vm.name,
        guestHostname: vm.guestHostname,
        ipAddresses: vm.ipAddresses,
        tags: vm.tags.map((t) =>
          t.categoryName ? `${t.categoryName}/${t.name}` : t.name
        ),
        reason: this.diagnoseUnmatchedVm(vm, allEndpoints),
      }));

    const unmatchedEndpoints: UnmatchedEndpointEntry[] = allEndpoints
      .filter((ep) => !matchedEndpointGuids.has(ep.agentGuid))
      .map((ep) => ({
        agentGuid: ep.agentGuid,
        endpointName: ep.endpointName,
        ipAddresses: ep.ipAddresses,
      }));

    const report: UnmatchedReport = {
      timestamp: new Date().toISOString(),
      unmatchedVms,
      unmatchedEndpoints,
      matchedCount: matches.length,
      totalVms: allVms.length,
      totalEndpoints: allEndpoints.length,
    };

    await this.ensureDirectory();
    await this.writeJsonReport(report);
    await this.writeTxtReport(report);

    return report;
  }

  /**
   * Diagnose why a VM could not be matched.
   */
  private diagnoseUnmatchedVm(
    vm: VmwareVm,
    allEndpoints: VisionOneEndpoint[]
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
    const partialMatches = allEndpoints.filter((ep) => {
      const normalizedEp = ep.endpointName.split('.')[0].toLowerCase();
      return (
        normalizedEp.includes(normalizedVm) ||
        normalizedVm.includes(normalizedEp)
      );
    });

    if (partialMatches.length > 0) {
      const names = partialMatches
        .slice(0, 3)
        .map((ep) => ep.endpointName)
        .join(', ');
      return `Possible partial hostname matches found: ${names}`;
    }

    return 'No matching endpoint found by hostname or IP';
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
  private async writeTxtReport(report: UnmatchedReport): Promise<void> {
    const txtPath = path.resolve(
      this.reportPath.replace('.json', '.txt')
    );

    const lines: string[] = [];

    lines.push('='.repeat(72));
    lines.push('UNMATCHED VM & ENDPOINT REPORT');
    lines.push(`Generated: ${report.timestamp}`);
    lines.push('='.repeat(72));
    lines.push('');
    lines.push(
      `Summary: ${report.matchedCount} matched | ` +
        `${report.unmatchedVms.length} unmatched VMs | ` +
        `${report.unmatchedEndpoints.length} unmatched endpoints | ` +
        `${report.totalVms} total VMs | ` +
        `${report.totalEndpoints} total endpoints`
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

    if (report.unmatchedEndpoints.length > 0) {
      lines.push('-'.repeat(72));
      lines.push('UNMATCHED ENDPOINTS');
      lines.push('-'.repeat(72));

      for (const ep of report.unmatchedEndpoints) {
        lines.push('');
        lines.push(`  Agent GUID: ${ep.agentGuid}`);
        lines.push(`  Name:       ${ep.endpointName}`);
        lines.push(
          `  IPs:        ${ep.ipAddresses.length > 0 ? ep.ipAddresses.join(', ') : '(none)'}`
        );
      }

      lines.push('');
    }

    // Suggest mapping overrides
    if (report.unmatchedVms.length > 0) {
      lines.push('-'.repeat(72));
      lines.push('SUGGESTED MAPPING OVERRIDES');
      lines.push('-'.repeat(72));
      lines.push('');
      lines.push(
        'To manually map unmatched VMs to endpoints, add entries to'
      );
      lines.push(
        'config/mapping-overrides.json in the "overrides" array:'
      );
      lines.push('');

      for (const vm of report.unmatchedVms) {
        lines.push(`  {`);
        lines.push(`    "vmId": "${vm.vmId}",`);
        lines.push(`    "vmName": "${vm.name}",`);
        lines.push(`    "agentGuid": "<PASTE_AGENT_GUID_HERE>",`);
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
