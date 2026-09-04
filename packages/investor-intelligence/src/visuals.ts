import { allowsPresentTense, type Capability } from './capabilities.js';
import type { VisualKind } from './opportunity.js';

/**
 * Visual recommendations.
 *
 * Two rules, both about not misleading a reader:
 *
 *   1. **Every visual is labelled by what it is.** An architecture diagram, a
 *      concept sketch, and a real screenshot make very different claims about
 *      what exists. A reader who cannot tell them apart has been misled even if
 *      every box in the diagram is accurate.
 *   2. **No photorealistic generation.** This module emits Mermaid — structural
 *      diagrams that obviously depict a system rather than photograph one.
 *      A rendered image of a robot arm captioned with DACAIS's name implies a
 *      product that does not exist, whatever the alt text says.
 */

export interface VisualRecommendation {
  kind: VisualKind;
  /** Shown with the visual. Not optional — it is what prevents the misreading. */
  label: string;
  caption: string;
  /** Mermaid source, where the visual is a diagram. */
  mermaid?: string;
  /** What a human must supply, where the visual cannot be generated. */
  requiresHuman?: string;
  rationale: string;
}

const LABELS: Record<VisualKind, string> = {
  actual_screenshot: 'Screenshot of running software',
  architecture_diagram: 'Architecture diagram — how the system is built',
  concept_visualization: 'Concept illustration — not an existing product',
  future_state_visualization: 'Future-state concept — not built',
  benchmark_chart: 'Measured benchmark',
  timeline: 'Timeline',
  control_loop_diagram: 'Control-flow diagram',
  system_topology: 'System topology',
  agent_execution_path: 'Agent execution path',
  before_after_workflow: 'Workflow comparison',
  demo_recording: 'Recording of running software',
};

export class VisualRecommender {
  /**
   * Chooses a visual for an opportunity.
   *
   * The choice is driven by what actually exists. A capability that only exists
   * as a direction gets a future-state diagram that says so; it never gets a
   * screenshot or a benchmark chart, because there is nothing to screenshot and
   * nothing measured to chart.
   */
  recommend(input: {
    capabilities: readonly Capability[];
    themeLabel: string;
    hasMeasuredMetric: boolean;
    assetType: string;
  }): VisualRecommendation {
    const working = input.capabilities.filter((capability) => allowsPresentTense(capability.status));
    const demonstrable = working.filter((capability) => capability.demonstrable);
    const future = input.capabilities.filter((capability) => !allowsPresentTense(capability.status));

    if (demonstrable.length && input.assetType === 'demo_description') {
      return {
        kind: 'demo_recording',
        label: LABELS.demo_recording,
        caption: `${demonstrable[0].name} running end to end.`,
        requiresHuman:
          'Record the actual system running. This must be a real capture — a reconstruction presented as a ' +
          'recording is a fabrication.',
        rationale: `${demonstrable[0].name} is demonstrable today, so showing it is stronger than describing it.`,
      };
    }

    if (input.hasMeasuredMetric && working.length) {
      return {
        kind: 'benchmark_chart',
        label: LABELS.benchmark_chart,
        caption: 'Measured performance, from recorded instrumentation.',
        requiresHuman:
          'Chart only metrics with status MEASURED. A chart with an unmeasured number is worse than no chart.',
        rationale: 'A measured number carries more weight with a technical audience than any description.',
      };
    }

    if (future.length && working.length) {
      return {
        kind: 'future_state_visualization',
        label: LABELS.future_state_visualization,
        caption: `What exists today, and where the architecture is intended to extend.`,
        mermaid: buildProgressionDiagram(working, future),
        rationale:
          'The honest and the more interesting framing: show the working foundation, then the intended ' +
          'extension, with the boundary between them drawn explicitly.',
      };
    }

    if (working.length) {
      return {
        kind: 'architecture_diagram',
        label: LABELS.architecture_diagram,
        caption: `How ${working[0].name} is structured.`,
        mermaid: buildControlLoopDiagram(working),
        rationale: 'The capability exists and can be described structurally, which is what a technical reader wants.',
      };
    }

    return {
      kind: 'concept_visualization',
      label: LABELS.concept_visualization,
      caption: `Conceptual framing of ${input.themeLabel}. Not an existing DACAIS product.`,
      mermaid: buildConceptDiagram(input.themeLabel),
      rationale:
        'No capability at working-prototype status intersects this theme, so nothing may be depicted as built. ' +
        'The visual is explicitly conceptual.',
    };
  }
}

/**
 * The authorization/evidence control loop.
 *
 * This is the diagram that actually differentiates the architecture: intent
 * flows down through an authorization boundary, and evidence flows back up. It
 * is drawn from the capabilities that really exist rather than from a template.
 */
export function buildControlLoopDiagram(capabilities: readonly Capability[]): string {
  const names = capabilities.slice(0, 3).map((capability) => sanitizeLabel(capability.name));
  const middle = names.length
    ? names.map((name, index) => `  C${index}["${name}"]`).join('\n')
    : '  C0["Agent runtime"]';
  const chain = names.length
    ? names.map((_, index) => `C${index}`).join(' --> ')
    : 'C0';

  return [
    'flowchart TD',
    '  H["Human intent"]',
    middle,
    '  T["Tool / system boundary"]',
    '  E["Evidence record"]',
    `  H --> ${chain.split(' --> ')[0]}`,
    ...(names.length > 1 ? [`  ${chain}`] : []),
    `  C${Math.max(0, names.length - 1)} --> T`,
    '  T --> E',
    '  E -.->|audit| H',
  ].join('\n');
}

/**
 * Working foundation on the left, intended direction on the right, with a
 * labelled boundary between them.
 *
 * The dashed boundary is the point of the diagram: it is what stops a reader
 * assuming the right-hand side exists.
 */
export function buildProgressionDiagram(
  working: readonly Capability[],
  future: readonly Capability[],
): string {
  const lines = ['flowchart LR', '  subgraph TODAY["Working today"]'];
  for (const [index, capability] of working.slice(0, 4).entries()) {
    lines.push(`    W${index}["${sanitizeLabel(capability.name)}"]`);
  }
  lines.push('  end', '  subgraph DIRECTION["In development / horizon — not built"]');
  for (const [index, capability] of future.slice(0, 4).entries()) {
    lines.push(`    F${index}["${sanitizeLabel(capability.name)} (${capability.status})"]`);
  }
  lines.push('  end', '  TODAY -.->|architecture intended to extend| DIRECTION');
  return lines.join('\n');
}

export function buildConceptDiagram(theme: string): string {
  return [
    'flowchart LR',
    `  A["${sanitizeLabel(theme)}"]`,
    '  B["Open problems"]',
    '  C["Where authorization and evidence apply"]',
    '  A --> B --> C',
  ].join('\n');
}

/**
 * Mermaid label sanitization.
 *
 * Quotes and brackets break the parser, and a broken diagram renders as raw
 * text in whatever it was pasted into.
 */
function sanitizeLabel(value: string): string {
  return value
    .replace(/["'`]/g, '')
    .replace(/[[\]{}()<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** Every visual kind, with what it claims and what it needs. */
export function describeVisualKinds(): Array<{ kind: VisualKind; label: string; generated: boolean }> {
  return (Object.keys(LABELS) as VisualKind[]).map((kind) => ({
    kind,
    label: LABELS[kind],
    // Only structural diagrams are machine-generated. Anything depicting the
    // real world must be captured by a human from the real thing.
    generated: kind !== 'actual_screenshot' && kind !== 'demo_recording' && kind !== 'benchmark_chart',
  }));
}
