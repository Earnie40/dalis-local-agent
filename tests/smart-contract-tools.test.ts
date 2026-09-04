import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SMART_CONTRACT_TOOLS,
  smartContractAnalyzeTool,
  smartContractReportTool,
} from '@dacai-local-agent/tools';

/**
 * The smart-contract tools as the agent loop sees them.
 *
 * Retrieval is disabled in these tests (`includeSupport: false`) so they assert
 * tool behaviour without depending on the embedding service.
 */

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dacai-sc-'));
  mkdirSync(join(root, 'contracts'), { recursive: true });
  writeFileSync(
    join(root, 'contracts', 'Vulnerable.sol'),
    `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;
contract Vulnerable {
    address public treasury;
    mapping(address => uint256) public balances;
    function setTreasury(address t) external { treasury = t; }
}`,
  );
  writeFileSync(join(root, 'notes.txt'), 'not a contract');
  return root;
}

describe('smart-contract tools', () => {
  it('is registered read-only and needs no elevated capability', () => {
    for (const tool of SMART_CONTRACT_TOOLS) {
      expect(tool.permissionTier).toBe('safe');
      expect(tool.requiresRead).toBe(true);
      expect(tool.requiresWrite).toBeUndefined();
      expect(tool.requiresShell).toBeUndefined();
      expect(tool.requiresNetwork).toBeUndefined();
    }
  });

  it('exposes no address or RPC parameter', () => {
    // Targeting a remote deployed contract is not a capability this tool has,
    // so there is deliberately no way to name one.
    for (const tool of SMART_CONTRACT_TOOLS) {
      const properties = Object.keys(
        (tool.inputSchema as { properties: Record<string, unknown> }).properties,
      );
      expect(properties).not.toContain('address');
      expect(properties).not.toContain('rpcUrl');
      expect(properties).not.toContain('chainId');
      expect((tool.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
  });

  it('refuses to run without a workspace root', async () => {
    await expect(
      smartContractAnalyzeTool.execute({ path: 'contracts/Vulnerable.sol' }, {}),
    ).rejects.toThrow(/requires an active workspace root/);
  });

  it('rejects a path that escapes the workspace', async () => {
    const root = workspace();
    await expect(
      smartContractAnalyzeTool.execute({ path: '../../etc/passwd.sol' }, { workspaceRoot: root }),
    ).rejects.toThrow(/escapes the workspace/i);
  });

  it('rejects a non-Solidity file', async () => {
    const root = workspace();
    await expect(
      smartContractAnalyzeTool.execute({ path: 'notes.txt' }, { workspaceRoot: root }),
    ).rejects.toThrow(/must reference a \.sol file/);
  });

  it('analyzes a contract and reports findings with provenance fields', async () => {
    const root = workspace();
    const result = (await smartContractAnalyzeTool.execute(
      { path: 'contracts/Vulnerable.sol', includeSupport: false },
      { workspaceRoot: root },
    )) as {
      path: string;
      contractName: string;
      findings: { category: string; observed: string; inference: string; status: string }[];
      limitations: string[];
      evidence: { analysisResultHash: string; anchoredOnChain: boolean };
    };

    expect(result.contractName).toBe('Vulnerable');
    expect(result.findings.some((f) => f.category === 'access-control')).toBe(true);
    for (const finding of result.findings) {
      expect(finding.observed).not.toBe(finding.inference);
      expect(['confirmed', 'possible']).toContain(finding.status);
    }
    expect(result.evidence.analysisResultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.anchoredOnChain).toBe(false);
  });

  it('reports a workspace-relative path, never an absolute one', async () => {
    const root = workspace();
    const result = (await smartContractAnalyzeTool.execute(
      { path: 'contracts/Vulnerable.sol', includeSupport: false },
      { workspaceRoot: root },
    )) as { path: string };

    // An absolute path leaks host layout into the model's context.
    expect(result.path).toBe('contracts/Vulnerable.sol');
    expect(result.path).not.toContain(root);
  });

  it('always returns its limitations so the review is not read as exhaustive', async () => {
    const root = workspace();
    const result = (await smartContractAnalyzeTool.execute(
      { path: 'contracts/Vulnerable.sol', includeSupport: false },
      { workspaceRoot: root },
    )) as { limitations: string[] };

    expect(result.limitations.length).toBeGreaterThan(0);
    expect(result.limitations.join(' ')).toContain('deployment configuration');
  });

  it('renders a human-readable report keeping observed and inferred apart', async () => {
    const root = workspace();
    const result = (await smartContractReportTool.execute(
      { path: 'contracts/Vulnerable.sol' },
      { workspaceRoot: root },
    )) as { report: string };

    expect(result.report).toContain('OBSERVED:');
    expect(result.report).toContain('INFERRED:');
    expect(result.report).toContain('LIMITATIONS:');
  });
});
