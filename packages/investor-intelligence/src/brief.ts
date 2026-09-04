import type { OpportunityRecord } from './opportunity.js';
import { OpportunityStore } from './opportunity.js';

/**
 * The daily intelligence brief.
 *
 * Returns a small number of high-confidence items, never a dump. A brief that
 * lists everything trains the reader to stop reading it; a brief that
 * confidently reports one or two things worth a human's attention earns
 * a second read tomorrow.
 */

export interface BriefItem {
  opportunity: OpportunityRecord;
  rank: number;
}

export interface Brief {
  generatedAt: string;
  items: BriefItem[];
  /** Set when nothing cleared the bar. A legitimate, reportable outcome. */
  belowThresholdCount: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.55;
const DEFAULT_MAX_ITEMS = 3;

export class BriefGenerator {
  constructor(private readonly opportunities = new OpportunityStore()) {}

  async generate(options: { minConfidence?: number; maxItems?: number } = {}): Promise<Brief> {
    const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;

    const qualifying = await this.opportunities.top(maxItems, minConfidence);
    const all = await this.opportunities.top(50, 0);

    return {
      generatedAt: new Date().toISOString(),
      items: qualifying.map((opportunity, index) => ({ opportunity, rank: index + 1 })),
      belowThresholdCount: all.length - qualifying.length,
    };
  }
}

/** Plain-text rendering matching the format in the design brief. */
export function renderBrief(brief: Brief): string {
  const date = new Date(brief.generatedAt).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  if (!brief.items.length) {
    return [
      'DACAIS SIGNAL BRIEF',
      date,
      '',
      `No opportunity cleared the confidence threshold today` +
        (brief.belowThresholdCount ? ` (${brief.belowThresholdCount} below threshold).` : '.'),
      'This is a legitimate result: it means nothing collected recently is both well-corroborated',
      'and clearly connected to demonstrable DACAIS evidence. Lower the threshold to review the',
      'lower-confidence items directly, or collect more signals.',
    ].join('\n');
  }

  const sections = brief.items.map((item) => {
    const opp = item.opportunity;
    return [
      `${item.rank === 1 ? 'Highest-Value Opportunity' : `Opportunity ${item.rank}`}`,
      '-'.repeat(33),
      '',
      'Signal:',
      opp.signalSummary,
      '',
      'Why it matters:',
      opp.whyItMatters,
      '',
      'DACAIS connection:',
      opp.dacaisIntersection,
      '',
      'Recommended asset:',
      opp.recommendedAssetType.replace(/_/g, ' '),
      '',
      'Suggested visual:',
      opp.suggestedVisual ?? '(none)',
      '',
      ...(opp.missingEvidence ? ['Gaps:', opp.missingEvidence, ''] : []),
      ...(opp.risks ? ['Risks:', opp.risks, ''] : []),
      `Confidence: ${opp.confidence.toFixed(2)}   Score: ${opp.score.toFixed(2)}`,
    ].join('\n');
  });

  return [`DACAIS SIGNAL BRIEF`, date, '', sections.join('\n\n')].join('\n');
}
