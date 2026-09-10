import type { ModelProvider } from '../packages/agent-core/src/types';
import { PROVENANCE } from '../packages/agent-core/src/evidence-provenance';

/**
 * Protocol fixture for existing loop/transport tests. Those tests isolate wire
 * replay, cancellation, mutation validation and retries; semantic decisions are
 * stubbed here. Reasoning correctness is exercised separately with adversarial
 * decisions and evidence in reasoning-regression.test.ts, with no stubbed gates.
 */
export function reasoningProtocolFixture(scope: 'conceptual' | 'repository' = 'conceptual'): Pick<ModelProvider, 'chat'> {
  let sequence = 0;
  return { async chat(request) {
    sequence += 1;
    const data = JSON.parse(request.messages[0].content);
    const phase = request.systemPrompt?.match(/REASONING_CONTROL:(\w+)/)?.[1];
    const statement = `Protocol fixture action ${sequence}`;
    let decision: unknown;
    if (phase === 'plan') decision = {
      successCondition: data.originalRequest,
      requirements: [{ id: 'result', requestClause: data.originalRequest, output: data.originalRequest,
        successCondition: data.originalRequest, scope, kind: 'answer', allowedProvenance: scope === 'repository' ? ['repository_code'] : [...PROVENANCE] }],
      hypotheses: [], unknowns: [data.originalRequest],
    };
    if (phase === 'plan_audit') decision = {
      complete: true,
      explanation: 'The isolated protocol fixture uses one request-wide output.',
      missingRequirements: [],
    };
    if (phase === 'action') decision = {
      relevant: true, requirementIds: ['result'], unknown: 'The result of the scripted action',
      prediction: 'The scripted tool will return its observation', causalJustification: 'The fixture exercises the tool observation required by this isolated loop test.',
      purpose: 'verify', informationGain: 1, higherInformationAlternative: '', requiredPlatform: 'any', platformCompatible: true, platformReason: 'The executor is mocked.',
      hypothesis: { statement, basis: 'Scripted isolated loop test', confidence: 0.9 },
      revision: data.state.revisionRequired ? { observationId: data.state.revisionRequired,
        failedAssumption: 'The preceding scripted call did not resolve the result', revisedHypothesis: statement,
        reason: 'Use the next scripted observation after the recorded failure' } : null,
    };
    if (phase === 'observation') decision = {
      actual: data.sources[0]?.content || 'Empty observation', predictionMatched: data.success, relevant: data.success,
      facts: data.sources.filter((s: { content: string }) => s.content).slice(0, 1).map((s: { id: string; content: string }) => ({
        requirementId: 'result', claim: `${s.content} (${data.observationId})`, sourceId: s.id, quote: s.content,
        mode: 'observation', confidence: 0.9,
      })), contradictedEvidenceIds: [], failedAssumption: data.success ? '' : 'The scripted call would succeed', revisedHypothesis: data.success ? '' : 'The next scripted step will resolve the outstanding requirement',
    };
    if (phase === 'verification') decision = {
      complete: true, explanation: 'Isolated test synthesis reviewed', coveredRequirementIds: ['result'], unsupportedClaims: [], uncoveredOutputs: [], implementationClaims: [], citations: [],
    };
    return { content: JSON.stringify(decision), model: request.model, providerInstanceId: 'protocol-fixture', usageClass: 'LOCAL_OLLAMA' };
  } };
}
