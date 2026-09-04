import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { resolveWithinWorkspace } from '@dacai-local-agent/security';
import { SmartContractReviewService, formatReport } from '@dacai-local-agent/smart-contract';
import type { ToolDefinition, ToolExecutionContext } from './types';

/**
 * Defensive smart-contract review, exposed to the agent loop.
 *
 * Scope, enforced rather than documented:
 *
 *  - Source is read only from inside the registered workspace, through
 *    resolveWithinWorkspace(), so a traversal or absolute path outside the
 *    workspace is rejected before any I/O.
 *  - Analysis is static and read-only. Nothing compiles, deploys, sends a
 *    transaction, or contacts a chain. There is no address or RPC parameter,
 *    because targeting a remote deployed contract is not a capability this
 *    tool has.
 *  - Findings separate observed fact from inference and carry a status of
 *    `confirmed` or `possible`, so the model is never handed a suspicion
 *    formatted as a fact.
 *
 * Tier is `safe`: it reads a workspace file and queries the local knowledge
 * store. It writes nothing and runs no subprocess.
 */

const MAX_SOURCE_BYTES = 1_000_000;

function requireRoot(ctx: ToolExecutionContext): string {
  if (!ctx.workspaceRoot) throw new Error('This tool requires an active workspace root.');
  return ctx.workspaceRoot;
}

async function loadContract(ctx: ToolExecutionContext, requested: unknown): Promise<{ path: string; source: string }> {
  const root = requireRoot(ctx);
  const raw = String(requested ?? '').trim();
  if (!raw) throw new Error('path is required.');
  if (!/\.sol$/i.test(raw)) throw new Error('path must reference a .sol file.');

  const target = resolveWithinWorkspace(root, raw);
  const source = await readFile(target, 'utf8');
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    throw new Error(`Contract exceeds the ${MAX_SOURCE_BYTES} byte analysis limit.`);
  }
  // Report workspace-relative; an absolute path leaks host layout.
  return { path: relative(root, target).replace(/\\/g, '/'), source };
}

const service = new SmartContractReviewService();

export const smartContractAnalyzeTool: ToolDefinition = {
  name: 'smartcontract.analyze',
  description:
    'Statically review a Solidity file inside the workspace for defensive security issues. ' +
    'Returns findings with severity, a separate confidence, a confirmed/possible status, ' +
    'the observed fact and the inference kept apart, remediation, a suggested defensive test, ' +
    'and supporting knowledge with provenance. Read-only: it never compiles, deploys, or sends a transaction.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        minLength: 1,
        maxLength: 600,
        description: 'Workspace-relative path to a .sol file.',
      },
      includeSupport: {
        type: 'boolean',
        description: 'Retrieve supporting corpus knowledge for each finding. Default true.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresRead: true,
  timeoutMs: 120_000,
  async execute(input, ctx) {
    const { path, source } = await loadContract(ctx, input.path);
    const report = await service.review(source, {
      retrieveSupport: input.includeSupport !== false,
    });

    return {
      path,
      contractName: report.contractName,
      functionsAnalyzed: report.functionsAnalyzed,
      summary: report.summary,
      findings: report.findings.map((f) => ({
        id: f.id,
        category: f.category,
        status: f.status,
        severity: f.severity,
        confidence: f.confidence,
        title: f.title,
        observed: f.observed,
        inference: f.inference,
        function: f.functionName,
        line: f.line,
        remediation: f.remediation,
        suggestedTest: f.suggestedTest,
        support: f.support.map((s) => ({
          title: s.title,
          source: s.source,
          license: s.license,
          contentHash: s.contentHash,
        })),
      })),
      // Always returned, so the model cannot present the review as exhaustive.
      limitations: report.limitations.notes,
      evidence: {
        analysisInputHash: report.evidence.analysisInputHash.digest,
        analysisResultHash: report.evidence.analysisResultHash.digest,
        anchoredOnChain: false,
      },
    };
  },
};

export const smartContractReportTool: ToolDefinition = {
  name: 'smartcontract.report',
  description:
    'Same defensive review as smartcontract.analyze, rendered as a readable report. ' +
    'Use when presenting findings to a human rather than processing them further.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, maxLength: 600 },
    },
    required: ['path'],
    additionalProperties: false,
  },
  permissionTier: 'safe',
  requiresRead: true,
  timeoutMs: 120_000,
  async execute(input, ctx) {
    const { path, source } = await loadContract(ctx, input.path);
    const report = await service.review(source);
    return { path, report: formatReport(report) };
  },
};

export const SMART_CONTRACT_TOOLS: ToolDefinition[] = [
  smartContractAnalyzeTool,
  smartContractReportTool,
];
