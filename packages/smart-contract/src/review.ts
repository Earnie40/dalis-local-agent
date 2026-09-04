import { anchorFor, type EvidenceAnchor } from '@dacai-local-agent/domain-knowledge';
import { RagService, type KnowledgeChunk } from '@dacai-local-agent/rag';
import { analyzeSolidity, type AnalysisResult, type Finding } from './analyzer.js';

/**
 * The smart-contract review path:
 *
 *   source -> static inspection -> retrieve smart-contract knowledge ->
 *   findings with severity/confidence -> remediation -> defensive tests ->
 *   evidence hashes
 *
 * Retrieval is scoped to the `smart-contract` domain, so supporting knowledge
 * comes from the curated corpus rather than from whatever happens to be nearest
 * in the whole vector store.
 */

export interface SupportedFinding extends Finding {
  /** Corpus passages retrieved for this finding, with provenance. */
  support: {
    title: string;
    source: string;
    license?: string;
    contentHash?: string;
    distance: number;
  }[];
}

export interface ReviewReport {
  contractName?: string;
  findings: SupportedFinding[];
  functionsAnalyzed: number;
  limitations: AnalysisResult['limitations'];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    informational: number;
    confirmed: number;
    possible: number;
  };
  evidence: {
    analysisInputHash: EvidenceAnchor;
    analysisResultHash: EvidenceAnchor;
  };
}

export interface ReviewOptions {
  /** Passages to retrieve per finding. */
  supportPerFinding?: number;
  /** Set false to analyse without touching the vector store. */
  retrieveSupport?: boolean;
}

export class SmartContractReviewService {
  constructor(private readonly rag = new RagService()) {}

  async review(source: string, options: ReviewOptions = {}): Promise<ReviewReport> {
    const { supportPerFinding = 2, retrieveSupport = true } = options;
    const analysis = analyzeSolidity(source);

    const findings: SupportedFinding[] = [];
    for (const finding of analysis.findings) {
      let support: SupportedFinding['support'] = [];
      if (retrieveSupport) {
        try {
          const hits = await this.rag.search(
            finding.knowledgeQuery,
            { domainIds: ['smart-contract'] },
            supportPerFinding,
          );
          // Several chunks of one document are one citation, not several.
          // Keeping duplicates makes a report look better-evidenced than it is.
          const bySource = new Map<string, SupportedFinding['support'][number]>();
          for (const hit of hits.map(toSupport)) {
            const existing = bySource.get(hit.source);
            if (!existing || hit.distance < existing.distance) bySource.set(hit.source, hit);
          }
          support = [...bySource.values()].sort((a, b) => a.distance - b.distance);
        } catch {
          // Retrieval is enrichment. A findings report without corpus support is
          // degraded but still valid, so an embedding outage must not fail the
          // whole review.
          support = [];
        }
      }
      findings.push({ ...finding, support });
    }

    const summary = {
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      informational: findings.filter((f) => f.severity === 'informational').length,
      confirmed: findings.filter((f) => f.status === 'confirmed').length,
      possible: findings.filter((f) => f.status === 'possible').length,
    };

    return {
      contractName: analysis.contractName,
      findings,
      functionsAnalyzed: analysis.functionsAnalyzed,
      limitations: analysis.limitations,
      summary,
      evidence: {
        analysisInputHash: anchorFor('sourceHash', { source }),
        analysisResultHash: anchorFor('evaluationHash', {
          contractName: analysis.contractName,
          findings: analysis.findings.map((f) => ({
            category: f.category, status: f.status, severity: f.severity, functionName: f.functionName,
          })),
        }),
      },
    };
  }
}

function toSupport(hit: KnowledgeChunk): SupportedFinding['support'][number] {
  return {
    title: hit.title ?? hit.source,
    source: hit.source,
    license: hit.provenance.license,
    contentHash: hit.provenance.contentHash,
    distance: hit.distance,
  };
}

/**
 * Renders a report with observation and inference kept visibly separate, so a
 * reader is never handed a suspicion formatted as a fact.
 */
export function formatReport(report: ReviewReport): string {
  const lines: string[] = [
    `Contract: ${report.contractName ?? '(unnamed)'} — ${report.functionsAnalyzed} function(s) analyzed`,
    `Findings: ${report.summary.confirmed} confirmed, ${report.summary.possible} possible ` +
      `(critical ${report.summary.critical}, high ${report.summary.high}, medium ${report.summary.medium})`,
    '',
  ];

  for (const finding of report.findings) {
    lines.push(`[${finding.id}] ${finding.severity.toUpperCase()} · ${finding.status.toUpperCase()} · confidence ${finding.confidence.toFixed(2)}`);
    lines.push(`  ${finding.title}`);
    lines.push(`  OBSERVED:  ${finding.observed}`);
    lines.push(`  INFERRED:  ${finding.inference}`);
    lines.push(`  REMEDIATE: ${finding.remediation}`);
    lines.push(`  TEST:      ${finding.suggestedTest}`);
    if (finding.support.length) {
      for (const s of finding.support) {
        lines.push(`  SUPPORT:   ${s.title} (${s.source} · ${s.license ?? 'no license'} · ${(s.contentHash ?? '').slice(0, 12)}…)`);
      }
    } else {
      lines.push('  SUPPORT:   (none retrieved)');
    }
    lines.push('');
  }

  lines.push('LIMITATIONS:');
  for (const note of report.limitations.notes) lines.push(`  - ${note}`);

  return lines.join('\n');
}
