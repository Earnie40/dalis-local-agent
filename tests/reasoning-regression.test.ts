import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runAgentLoop, type ToolExecutor, type LoopEvent } from '../packages/agent-core/src/agent-loop';
import { ReasoningController, reasoningAcceptance, type EvidenceRequirement, type ReasoningState } from '../packages/agent-core/src/reasoning-controller';
import { sourcesForResult, type EvidenceSource } from '../packages/agent-core/src/evidence-provenance';
import { buildWorkingStateContext, compactMessagesForRequest } from '../packages/agent-core/src/runtime-state';
import type { ModelChatRequest, ModelChatResponse, ModelProvider, NormalizedToolCall, ToolSchema } from '../packages/agent-core/src/types';

const windows = { platform: 'win32', shell: 'cmd.exe', arch: 'x64' };
const schema = (name: string, description = name): ToolSchema => ({ name, description, inputSchema: { type: 'object' } });
const call = (name: string, args: Record<string, unknown> = {}): NormalizedToolCall => ({ name, arguments: args, id: `call-${name}` });
const response = (content: string, toolCalls?: NormalizedToolCall[]): ModelChatResponse => ({ content, toolCalls, model: 'mock', providerInstanceId: 'mock', usageClass: 'LOCAL_OLLAMA' });
const source = (content: string, provenance: EvidenceSource['provenance'], locator = 'mock provider account', effect: EvidenceSource['effect'] = 'read'): EvidenceSource => ({ id: 's1', content, provenance, locator, effect });
const requirement = (goal: string, id = 'account'): EvidenceRequirement => ({ id, requestClause: goal, output: id, successCondition: `Observe ${id} for the owner`, scope: 'user_specific', kind: 'fact', allowedProvenance: ['local_machine', 'production_data'] });

type DecisionInput = { state: ReasoningState; candidate: NormalizedToolCall; tool: ToolSchema; sources: EvidenceSource[]; success: boolean; observationId: string; draft: string };

/** The model boundary is mocked; schema/origin/revision/completion gates are real. */
function controllerProvider(requirements: EvidenceRequirement[], customize?: (phase: string, input: DecisionInput, decision: Record<string, unknown>) => unknown): Pick<ModelProvider, 'chat'> {
  let number = 0;
  return { async chat(request) {
    number += 1;
    const phase = request.systemPrompt!.match(/REASONING_CONTROL:(\w+)/)![1];
    const input = JSON.parse(request.messages[0].content) as DecisionInput;
    const statement = `Hypothesis ${number}: inspect a source that can establish the outstanding fact`;
    let decision: Record<string, unknown> = {};
    if (phase === 'plan') decision = { successCondition: 'Every requested output is observed from admissible evidence', requirements, hypotheses: [{ statement: 'A local provider may expose the active account', basis: 'Unverified approach', confidence: 0.4 }], unknowns: requirements.map(r => r.output) };
    if (phase === 'plan_audit') decision = {
      complete: true,
      explanation: 'Every requested output has its own requirement in this test plan.',
      missingRequirements: [],
    };
    if (phase === 'action') decision = {
      relevant: true, requirementIds: requirements.map(r => r.id), unknown: 'The owner-specific account facts',
      prediction: 'This source may expose the required account facts', causalJustification: 'The proposed source exposes account state or the procedure for obtaining that state.',
      purpose: 'observe', informationGain: 0.9, higherInformationAlternative: '', requiredPlatform: 'any', platformCompatible: true, platformReason: 'The tool is mocked on the registered Windows host.',
      hypothesis: { statement, basis: 'Update grounded in the previous observation', confidence: 0.7 },
      revision: input.state.revisionRequired ? { observationId: input.state.revisionRequired, failedAssumption: 'The prior source would establish the owner-specific fact', revisedHypothesis: statement, reason: 'The recorded result failed or did not provide admissible evidence.' } : null,
    };
    if (phase === 'observation') decision = {
      actual: input.sources.map(s => s.content).join('\n') || 'No output', predictionMatched: input.success, relevant: input.success,
      // Deliberately overclaim that every returned value proves a fact. The
      // runtime must still reject decoy origins even with confidence 1.
      facts: input.sources.flatMap(s => requirements.map(r => ({ requirementId: r.id, claim: s.content, sourceId: s.id, quote: s.content, mode: 'observation', confidence: 1 }))),
      contradictedEvidenceIds: [], failedAssumption: 'The source contained the required real-world fact', revisedHypothesis: 'The result does not establish the owner-specific fact; inspect a different authoritative source',
    };
    if (phase === 'verification') decision = {
      complete: true, explanation: 'Mock semantic verifier accepts the draft; runtime evidence checks still apply',
      coveredRequirementIds: requirements.map(r => r.id), unsupportedClaims: [], uncoveredOutputs: [], implementationClaims: [],
      citations: requirements.flatMap(r => { const ids = input.state.evidence.filter(e => e.requirementId === r.id && e.accepted && !e.contradicted).map(e => e.id); return ids.length ? [{ requirementId: r.id, evidenceIds: ids, answerExcerpt: input.draft }] : []; }),
    };
    return response(JSON.stringify(customize?.(phase, input, decision) ?? decision));
  } };
}

function isPhase(request: ModelChatRequest, phase: string): boolean {
  return request.systemPrompt?.includes(`REASONING_CONTROL:${phase}\n`) === true;
}

/**
 * Decisions bound to the contract the runtime currently holds, so one script
 * works under both a provisional and an audited contract. `plan` may return a
 * malformed response, or undefined to fall through to a valid plan.
 */
function contractBoundProvider(plan: () => ModelChatResponse | undefined): Pick<ModelProvider, 'chat'> {
  return { async chat(request) {
    const input = JSON.parse(request.messages[0].content) as Partial<DecisionInput> & { originalRequest?: string };
    const ids = (input.state?.requiredEvidence ?? []).map(item => item.id);
    const sources = input.sources ?? [];
    if (isPhase(request, 'plan')) return plan() ?? response(JSON.stringify({
      successCondition: 'Observe the requested account from an authorized local source',
      requirements: [requirement(input.originalRequest ?? '')], hypotheses: [], unknowns: [],
    }));
    if (isPhase(request, 'plan_audit')) return response(JSON.stringify({
      complete: true, explanation: 'Every requested output has its own requirement.', missingRequirements: [],
    }));
    if (isPhase(request, 'action')) return response(JSON.stringify({
      relevant: true, requirementIds: ids, unknown: 'The active local account',
      prediction: 'The authorized local provider returns the active account',
      causalJustification: 'The registered tool reads the account state the request asks about.',
      purpose: 'observe', informationGain: 0.9, higherInformationAlternative: '',
      requiredPlatform: 'any', platformCompatible: true, platformReason: 'The tool is mocked on the registered host.',
      hypothesis: { statement: 'The local provider exposes the active account', basis: 'Registered tool description', confidence: 0.7 },
      revision: input.state?.revisionRequired
        ? { observationId: input.state.revisionRequired, failedAssumption: 'The prior source established the account',
          revisedHypothesis: 'The local provider exposes the active account', reason: 'The recorded result supplied no admissible evidence.' }
        : null,
    }));
    if (isPhase(request, 'observation')) return response(JSON.stringify({
      actual: sources.map(item => item.content).join(' ') || 'No output',
      predictionMatched: input.success === true, relevant: input.success === true,
      facts: ids.flatMap(id => sources.map(item => ({ requirementId: id, claim: item.content, sourceId: item.id, quote: item.content, mode: 'observation', confidence: 1 }))),
      contradictedEvidenceIds: [], failedAssumption: '', revisedHypothesis: '',
    }));
    return response(JSON.stringify({
      complete: true, explanation: 'Reviewed against the runtime ledger', coveredRequirementIds: ids,
      unsupportedClaims: [], uncoveredOutputs: [], implementationClaims: [],
      citations: ids.flatMap(id => {
        const evidenceIds = (input.state?.evidence ?? []).filter(item => item.requirementId === id && item.accepted && !item.contradicted).map(item => item.id);
        return evidenceIds.length ? [{ requirementId: id, evidenceIds, answerExcerpt: input.draft! }] : [];
      }),
    }));
  } };
}

function primaryProvider(turns: Array<ModelChatResponse | ((request: ModelChatRequest) => ModelChatResponse)>, controller: Pick<ModelProvider, 'chat'>): ModelProvider {
  let index = 0;
  return {
    instanceId: 'mock', kind: 'ollama', usageClass: 'LOCAL_OLLAMA',
    async chat(request) {
      // Exercise default production wiring: no reasoningProvider override.
      if (request.systemPrompt?.includes('REASONING_CONTROL:')) return controller.chat(request);
      const turn = turns[Math.min(index++, turns.length - 1)];
      return typeof turn === 'function' ? turn(request) : turn;
    },
    supportsTools: () => 'verified', listModels: async () => [], getUsage: async () => ({}),
    health: async () => ({ status: 'connected', instanceId: 'mock', usageClass: 'LOCAL_OLLAMA', location: 'Local' }),
  };
}

describe('general reasoning regression', () => {
  it.each([
    { goal: 'Find my MetaMask wallet address and report its active chain.', label: 'wallet', doc: 'wallet:0xabc', fake: '0x' + 'f'.repeat(40), url: 'https://docs.metamask.io/wallet/', value: () => '0x' + randomBytes(20).toString('hex') },
    { goal: 'Find my laboratory instrument serial number and report its firmware.', label: 'instrument', doc: 'serial:DEMO', fake: 'TEST-DEVICE', url: 'https://vendor.invalid/manual', value: () => 'SN-' + randomBytes(10).toString('hex') },
  ])('rejects decoys and irrelevant actions, then completes unfamiliar task: $label', async scenario => {
    const authoritative = scenario.value();
    const requirements = [requirement(scenario.goal), requirement(scenario.goal, 'configuration')];
    const executed: NormalizedToolCall[] = [];
    const events: LoopEvent[] = [];
    const controller = controllerProvider(requirements, (phase, input, decision) => {
      if (phase === 'action') {
        if (input.candidate.name === 'system.network.info' || String(input.candidate.arguments.command).includes('getent hosts')) {
          return { ...decision, relevant: false, causalJustification: 'Hostname resolution and Wi-Fi connection details cannot expose the requested application account state.' };
        }
        if (input.candidate.name === 'shell.run') return { ...decision, platformCompatible: false, platformReason: 'The proposed Linux-only command cannot run in cmd.exe.' };
      }
      if (phase === 'observation' && input.sources[0]?.locator === 'authoritative local adapter') {
        return { ...decision, facts: [{ requirementId: 'account', claim: authoritative, sourceId: 's1', quote: authoritative, mode: 'observation', confidence: 1 }] };
      }
      if (phase === 'observation' && input.sources[0]?.locator === 'authoritative configuration adapter') {
        return { ...decision, facts: [{ requirementId: 'configuration', claim: 'configured-value', sourceId: 's1', quote: 'configured-value', mode: 'observation', confidence: 1 }] };
      }
      if (phase === 'verification' && input.draft.includes('implemented')) return { ...decision, implementationClaims: [{ claim: input.draft, requirementId: 'account' }] };
      return decision;
    });
    const tools = [schema('filesystem.read', 'Read a repository file'), schema('web.fetch', 'Read a public web page'),
      schema('shell.run', 'Run a command in the registered host shell'), schema('system.network.info', 'Read Wi-Fi connection and SSID'),
      schema('local.record', 'Read the public account identifier from the authorized local application provider'), schema('local.configuration', 'Read the active configuration from the same local provider')];
    const executor: ToolExecutor = { listTools: () => tools, async execute(c) {
      executed.push(c);
      if (c.name === 'filesystem.read') return { success: true, output: String(c.arguments.path).startsWith('tests/') ? scenario.fake : scenario.doc };
      if (c.name === 'web.fetch') return { success: true, output: 'Public documentation example account', sources: [source('Public documentation example account', 'documentation', scenario.url)] };
      if (c.name === 'local.record' && c.arguments.profile === 'first') return { success: true, output: '{"exitCode":1,"stderr":"profile unavailable"}' };
      if (c.name === 'local.record') return { success: true, output: authoritative, sources: [source(authoritative, 'local_machine', 'authoritative local adapter')] };
      if (c.name === 'local.configuration') return { success: true, output: 'configured-value', sources: [source('configured-value', 'production_data', 'authoritative configuration adapter')] };
      throw new Error('Irrelevant or incompatible action reached the executor');
    } };
    const turns = [
      response('', [call('filesystem.read', { path: 'docs/example.md' })]),
      response(`TASK_COMPLETE: Found ${scenario.doc}. TRUE AGENTIC REASONING PRESENT.`),
      response('', [call('filesystem.read', { path: 'tests/accounts.test.ts' })]),
      response('', [call('filesystem.read', { path: 'corpus/observations.json' })]),
      response('', [call('web.fetch', { url: scenario.url })]),
      response('', [call('shell.run', { command: 'getent hosts | grep -i metamask' })]),
      response('', [call('system.network.info')]),
      response('', [call('shell.run', { command: 'ls /proc/example-process' })]),
      response('', [call('local.record', { profile: 'first' })]),
      (request: ModelChatRequest) => {
        expect(request.systemPrompt).toContain('revisionRequired');
        expect(request.systemPrompt).toContain('profile unavailable');
        return response('', [call('local.record', { profile: 'second' })]);
      },
      response(`TASK_COMPLETE: Found ${authoritative}.`), // Still lacks configuration.
      response('', [call('local.configuration')]),
      response(`TASK_COMPLETE: I implemented a capability and found ${authoritative}; configured-value.`),
      response(`TASK_COMPLETE: Observed ${authoritative}; configured-value. Used the existing provider tool.`),
    ];
    const result = await runAgentLoop({ provider: primaryProvider(turns, controller), executor, model: 'mock',
      capabilities: { toolCalling: 'verified', streaming: 'unsupported' }, prompt: scenario.goal,
      executionEnvironment: windows, maxTurns: 20, maxToolCalls: 14, onEvent: e => events.push(e) });
    expect(result.completionState).toBe('GOAL_COMPLETE');
    expect(result.answer).toContain(authoritative);
    for (const decoy of [scenario.doc, scenario.fake, 'implemented', 'TRUE AGENTIC']) expect(result.answer).not.toContain(decoy);
    expect(executed.some(c => ['shell.run', 'system.network.info'].includes(c.name))).toBe(false);
    expect(events.some(e => e.type === 'model_response' && e.content?.includes(scenario.doc))).toBe(false);
    const state = result.workingState.reasoning!;
    expect(state.evidence.filter(e => e.accepted).map(e => e.claim)).toEqual([authoritative, 'configured-value']);
    expect(state.evidence.filter(e => !e.accepted).map(e => e.source.provenance)).toEqual(expect.arrayContaining(['documentation', 'fixture', 'example']));
    expect(state.observations.find(o => o.tool === 'local.record' && !o.success)?.failedAssumption).toBeTruthy();
    expect(state.revisions.length).toBeGreaterThanOrEqual(4);
    expect(reasoningAcceptance(state, scenario.goal).ok).toBe(true);
    expect(result.turns).toBeLessThan(20);
  });

  it('requires revision after irrelevant successful output and rejects an unchanged hypothesis', async () => {
    const goal = 'Observe the active local account';
    const provider = controllerProvider([requirement(goal)], (phase, _input, decision) => phase === 'action' ? { ...decision, revision: null } : phase === 'observation' ? { ...decision, relevant: false } : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    const candidate = call('local.lookup');
    const action = (await controller.assess(candidate, schema(candidate.name))).action!;
    const observed = await controller.observe(candidate, { success: true, output: 'Wi-Fi SSID: decoy', sources: [source('Wi-Fi SSID: decoy', 'local_machine')] }, action);
    expect(observed.progress).toBe(false);
    expect(controller.state.evidence.every(e => !e.accepted)).toBe(true);
    expect((await controller.assess(call('local.next'), schema('local.next'))).reason).toContain('hypothesis revision');
  });

  it('repairs an initial plan that omitted an original requested output', async () => {
    const goal = 'Observe the active identifier and configuration';
    const identifier = requirement(goal, 'identifier');
    const configuration = requirement(goal, 'configuration');
    const provider = controllerProvider([identifier], (phase, _input, decision) =>
      phase === 'plan_audit'
        ? { complete: false, explanation: 'Configuration was omitted.', missingRequirements: [configuration] }
        : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    expect(controller.state.requiredEvidence.map(item => item.id)).toEqual(['identifier', 'configuration']);
    expect(controller.state.unknowns).toEqual(expect.arrayContaining(['identifier', 'configuration']));
  });

  it('compares a declared command platform against trusted host and target metadata', async () => {
    const goal = 'Observe operating system details';
    const provider = controllerProvider([requirement(goal)], (phase, _input, decision) => phase === 'action'
      ? { ...decision, requiredPlatform: 'linux', platformCompatible: true, platformReason: 'The command requires a Linux environment' } : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2, environment: windows });
    await controller.initialize();
    expect((await controller.assess(call('shell.run', { command: 'uname -a', platform: 'linux' }), schema('shell.run'))).ok).toBe(false);
    expect((await controller.assess(call('wsl.run', { command: 'uname -a' }), {
      ...schema('wsl.run'), executionEnvironment: { platform: 'linux', shell: '/bin/bash', arch: 'unknown' },
    })).ok).toBe(true);
  });

  it.each(['invented citation', 'omitted original output'])('rejects final verification with an %s', async defect => {
    const goal = 'Observe the active local account';
    const controller = new ReasoningController({ goal, provider: controllerProvider([requirement(goal)], (phase, _input, decision) =>
      phase !== 'verification' ? decision : defect === 'invented citation'
        ? { ...decision, citations: [{ requirementId: 'account', evidenceIds: ['never-observed'], answerExcerpt: 'observed' }] }
        : { ...decision, uncoveredOutputs: ['Another output required by the original request is missing'] }),
      model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    const c = call('local.read'); const a = (await controller.assess(c, schema(c.name))).action!;
    await controller.observe(c, { success: true, output: 'observed', sources: [source('observed', 'local_machine')] }, a);
    expect((await controller.verify('TASK_COMPLETE: observed')).ok).toBe(false);
  });

  it('can establish an explicitly requested error without treating failed execution as a successful mutation', async () => {
    const goal = 'Reproduce and report the command exit code';
    const r = { ...requirement(goal), scope: 'local_machine' as const };
    const provider = controllerProvider([r], (phase, _input, decision) => phase === 'observation'
      ? { ...decision, relevant: true, predictionMatched: true } : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    const c = call('local.reproduce'); const a = (await controller.assess(c, schema(c.name))).action!;
    await controller.observe(c, { success: false, output: 'exitCode: 1', sources: [source('exitCode: 1', 'local_machine', 'process exit receipt')] }, a);
    expect((await controller.verify('TASK_COMPLETE: observed exitCode: 1')).ok).toBe(true);
    expect(controller.state.observations[0].success).toBe(false);
  });

  it.each(['inference', 'speculation', 'invented quote', 'low confidence'])('rejects %s as local observation', async mode => {
    const goal = 'Observe the active local account';
    const provider = controllerProvider([requirement(goal)], (phase, _input, decision) => {
      if (phase !== 'observation') return decision;
      const facts = decision.facts as Array<Record<string, unknown>>;
      return { ...decision, facts: facts.map(f => ({ ...f, ...(mode === 'invented quote' ? { quote: 'not returned' } : mode === 'low confidence' ? { confidence: 0.2 } : { mode }) })) };
    });
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    const candidate = call('local.lookup');
    const action = (await controller.assess(candidate, schema(candidate.name))).action!;
    await controller.observe(candidate, { success: true, output: 'observed', sources: [source('observed', 'local_machine')] }, action);
    expect((await controller.verify('TASK_COMPLETE: observed')).ok).toBe(false);
  });

  it('requires mutation and later validation to call a capability implemented; ordinary reads are insufficient', async () => {
    const goal = 'Implement the requested capability';
    const r: EvidenceRequirement = { ...requirement(goal), scope: 'repository', kind: 'implementation', allowedProvenance: ['local_machine', 'repository_code'] };
    const controller = new ReasoningController({ goal, provider: controllerProvider([r]), model: 'mock', maxTurns: 10, maxToolCalls: 6, reserveTurns: 2 });
    await controller.initialize();
    for (const effect of ['read', 'mutation', 'validation'] as const) {
      const candidate = call(`mock.${effect}`);
      const action = (await controller.assess(candidate, schema(candidate.name))).action!;
      await controller.observe(candidate, { success: true, output: effect, sources: [source(effect, 'local_machine', 'runtime receipt', effect)] }, action);
      expect((await controller.verify('TASK_COMPLETE: implemented')).ok).toBe(effect === 'validation');
    }
  });

  it('reserves synthesis and favors a direct observation over broad discovery near the turn ceiling', async () => {
    const goal = 'Observe local status';
    const provider = controllerProvider([requirement(goal)], (phase, input, decision) => phase === 'action' && input.candidate.name === 'broad.search' ? { ...decision, purpose: 'discover', informationGain: 0.2 } : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 6, reserveTurns: 2 });
    await controller.initialize(); controller.updateBudget(2, 3);
    expect((await controller.assess(call('broad.search'), schema('broad.search'))).ok).toBe(false);
    expect((await controller.assess(call('direct.observe'), schema('direct.observe'))).ok).toBe(true);
    controller.updateBudget(1, 2);
    expect((await controller.assess(call('direct.observe'), schema('direct.observe'))).ok).toBe(false);
  });

  it('invalidates contradicted evidence and retains source-qualified state through message compaction', async () => {
    const goal = 'Observe local status';
    const provider = controllerProvider([requirement(goal)], (phase, input, decision) => phase === 'observation' && input.observationId === 'o2' ? { ...decision, facts: [], contradictedEvidenceIds: ['e1'], predictionMatched: false } : phase === 'action' ? { ...decision, purpose: 'verify' } : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 6, reserveTurns: 2 });
    await controller.initialize();
    for (const content of ['initial', 'contradiction']) {
      const c = call('local.status', { version: content }); const a = (await controller.assess(c, schema(c.name))).action!;
      await controller.observe(c, { success: true, output: content, sources: [source(content, 'local_machine')] }, a);
    }
    expect((await controller.verify('TASK_COMPLETE: initial')).ok).toBe(false);
    const systemPrompt = buildWorkingStateContext({ goal, turn: 5, reasoningMode: 'deep', knownPaths: [], changedFiles: [], succeededTools: [], recentFailures: [], validationResults: [], reasoning: controller.state });
    const compacted = compactMessagesForRequest({ systemPrompt, messages: Array.from({ length: 30 }, () => ({ role: 'tool' as const, content: 'x'.repeat(3000) })), maxContextTokens: 4096 });
    expect(compacted.compacted).toBe(true);
    expect(systemPrompt).toContain('"contradicted":true');
    expect(systemPrompt).toContain('local_machine');
    expect(controller.state.requiredEvidence).toHaveLength(1);
  });

  it('recovers a malformed planning response through formatting repair alone', async () => {
    const goal = 'Observe the active local account';
    const diagnostics: string[] = [];
    let planRequests = 0;
    const valid = controllerProvider([requirement(goal)]);
    const controller = new ReasoningController({ goal, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2,
      onDiagnostic: diagnostic => diagnostics.push(`${diagnostic.phase}:${diagnostic.stage}`),
      provider: { async chat(request) {
        const decision = await valid.chat(request);
        if (!isPhase(request, 'plan')) return decision;
        planRequests += 1;
        // Prose, a markdown fence and a trailing comma: recoverable formatting
        // damage, so no corrective retry should be needed.
        return response(`Here is the plan.\n\n\`\`\`json\n${decision.content.replace(/\}$/, ',}')}\n\`\`\`\n`);
      } } });
    await controller.initialize();
    expect(planRequests).toBe(1);
    expect(controller.planningStatus()).toBe('ready');
    expect(controller.state.requiredEvidence.map(item => item.id)).toEqual(['account']);
    expect(diagnostics).toContain('plan:repair');
    expect(diagnostics).not.toContain('plan:retry');
  });

  it('accepts a corrected planning response after one retry carrying the validation errors', async () => {
    const goal = 'Observe the active local account';
    const valid = controllerProvider([requirement(goal)]);
    const feedback: string[] = [];
    let planRequests = 0;
    const controller = new ReasoningController({ goal, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2,
      provider: { async chat(request) {
        const decision = await valid.chat(request);
        if (!isPhase(request, 'plan')) return decision;
        planRequests += 1;
        if (planRequests > 1) {
          feedback.push(request.messages.map(message => message.content).join('\n'));
          return decision;
        }
        // Two complete objects: choosing one would change meaning, so repair
        // must refuse and the controller must ask for a correction instead.
        return response(`${decision.content}\n${decision.content}`);
      } } });
    await controller.initialize();
    expect(planRequests).toBe(2);
    expect(controller.planningStatus()).toBe('ready');
    expect(feedback[0]).toContain('multiple JSON values');
    expect(feedback[0]).toContain('unknown solution path is valid');
    expect(controller.state.requiredEvidence.map(item => item.id)).toEqual(['account']);
  });

  it('derives admissible provenance when optional planning fields are omitted', async () => {
    const goal = 'Observe the active local account';
    const provider = controllerProvider([requirement(goal)], (phase, _input, decision) => {
      if (phase !== 'plan') return decision;
      // No hypotheses, no unknowns, and no provenance list at all.
      return { successCondition: decision.successCondition,
        requirements: (decision.requirements as Array<Record<string, unknown>>).map(({ allowedProvenance: _omitted, ...rest }) => rest) };
    });
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    expect(controller.planningStatus()).toBe('ready');
    expect(controller.state.hypotheses).toEqual([]);
    expect(controller.state.requiredEvidence[0].allowedProvenance).toEqual(['local_machine', 'production_data']);
    // A derived list is never wider than the requirement scope allows.
    for (const provenance of ['documentation', 'fixture', 'example', 'inference', 'speculation', 'unknown']) {
      expect(controller.state.requiredEvidence[0].allowedProvenance).not.toContain(provenance);
    }
    const candidate = call('local.read');
    const action = (await controller.assess(candidate, schema(candidate.name))).action!;
    await controller.observe(candidate, { success: true, output: 'observed', sources: [source('observed', 'local_machine')] }, action);
    expect((await controller.verify('TASK_COMPLETE: observed')).ok).toBe(true);
  });

  it('repairs an all-invalid planner provenance list with conservative runtime-owned provenance', async () => {
    const goal = 'Locate the connected Silverado and observe its interface status';
    const localRequirement = requirement(goal, 'vehicle-interface');
    const provider = controllerProvider([localRequirement], (phase, _input, decision) => {
      if (phase !== 'plan') return decision;
      return {
        ...decision,
        requirements: (decision.requirements as EvidenceRequirement[]).map(item => ({
          ...item,
          scope: 'local_machine',
          // This reproduces the live small-model failure: neither source can
          // establish local machine state.
          allowedProvenance: ['inference', 'public_source'],
        })),
      };
    });
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });

    await controller.initialize();

    expect(controller.planningStatus()).toBe('ready');
    expect(controller.state.requiredEvidence[0].allowedProvenance).toEqual(['local_machine', 'production_data']);
  });

  it('binds a relevant read-only discovery action when a small model emits boolean unknown and no requirement IDs', async () => {
    const goal = 'Find how to inspect the Silverado OBD interface';
    const diagnostics: string[] = [];
    const provider = controllerProvider([requirement(goal, 'obd-interface')], (phase, _input, decision) => phase === 'action'
      ? { ...decision, purpose: 'discover', requirementIds: [], unknown: true }
      : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2,
      onDiagnostic: diagnostic => diagnostics.push(`${diagnostic.phase}:${diagnostic.stage}`) });
    await controller.initialize();

    const assessed = await controller.assess(
      call('web.search', { query: 'Silverado OBD official interface documentation' }),
      schema('web.search', 'Search public documentation for an unfamiliar interface'),
    );

    expect(assessed.ok).toBe(true);
    expect(assessed.action?.requirementIds).toEqual(['obd-interface']);
    expect(typeof assessed.action?.unknown).toBe('string');
    expect(controller.state.nextAction?.tool).toBe('web.search');
    expect(diagnostics).toEqual(expect.arrayContaining(['action:repair']));
  });

  it('falls back after malformed control JSON only for a task-related read-only discovery action', async () => {
    const goal = 'Find how to inspect the Silverado OBD interface';
    const valid = controllerProvider([requirement(goal, 'obd-interface')]);
    const diagnostics: string[] = [];
    const provider: Pick<ModelProvider, 'chat'> = { chat: async request =>
      isPhase(request, 'action') || isPhase(request, 'observation')
        ? response('{bad-json')
        : valid.chat(request) };
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2,
      onDiagnostic: diagnostic => diagnostics.push(`${diagnostic.phase}:${diagnostic.stage}`) });
    await controller.initialize();

    const candidate = call('web.search', { query: 'Silverado OBD official interface documentation' });
    const assessed = await controller.assess(candidate, schema('web.search', 'Search public documentation'));
    expect(assessed.ok).toBe(true);
    const observed = await controller.observe(candidate, {
      success: true,
      output: 'Official documentation describes the supported diagnostic interface.',
      sources: [source('Official documentation describes the supported diagnostic interface.', 'documentation', 'https://example.invalid/official')],
    }, assessed.action!);

    expect(observed.progress).toBe(true);
    expect(controller.requirementSatisfied(controller.state.requiredEvidence[0])).toBe(false);
    expect(controller.state.evidence.filter(item => item.accepted)).toHaveLength(0);
    expect(diagnostics).toEqual(expect.arrayContaining(['action:fallback', 'observation:fallback']));

    const unrelated = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await unrelated.initialize();
    await expect(unrelated.assess(
      call('web.search', { query: 'unrelated weather forecast' }),
      schema('web.search', 'Search public documentation'),
    )).rejects.toThrow();
  });

  it('does not use discovery recovery to authorize a mutation with missing requirement IDs', async () => {
    const goal = 'Update the requested repository file';
    const provider = controllerProvider([requirement(goal, 'change')], (phase, _input, decision) => phase === 'action'
      ? { ...decision, purpose: 'mutate', requirementIds: [], unknown: true }
      : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();

    const assessed = await controller.assess(
      call('filesystem.write', { path: 'src/example.ts', content: 'change' }),
      schema('filesystem.write', 'Write a repository file'),
    );

    expect(assessed.ok).toBe(false);
    expect(assessed.action).toBeDefined();
  });

  it('starts an unfamiliar task with an unknown solution path and no invented hypothesis', async () => {
    const goal = 'Establish how the connected device reports its own calibration state';
    const provider = controllerProvider([requirement(goal, 'calibration')], (phase, _input, decision) => phase === 'plan'
      ? { ...decision, hypotheses: [], unknowns: ['The procedure for reading calibration state is unknown.'] }
      : decision);
    const controller = new ReasoningController({ goal, provider, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    expect(controller.state.hypotheses).toEqual([]);
    expect(controller.state.unknowns).toContain('The procedure for reading calibration state is unknown.');
    // Discovery stays admissible while the solution path is unresolved.
    expect((await controller.assess(call('local.discover'), schema('local.discover', 'List the interfaces the device exposes'))).ok).toBe(true);
  });

  it('starts ordinary reasoning on a provisional contract when planning cannot be validated', async () => {
    const goal = 'Observe the active local account';
    const executed: NormalizedToolCall[] = [];
    const diagnostics: Array<{ phase: string; stage: string }> = [];
    let plannerUsable = false;
    const controller = contractBoundProvider(() => plannerUsable ? undefined : response('{bad-json'));
    const turns = [
      response('', [call('local.read', { profile: 'first' })]),
      response('TASK_COMPLETE: fabricated'),
      response('', [call('local.read', { profile: 'second' })]),
      response('TASK_COMPLETE: observed'),
    ];
    const result = await runAgentLoop({ provider: primaryProvider(turns, controller), model: 'mock',
      capabilities: { toolCalling: 'verified', streaming: 'unsupported' }, prompt: goal, maxTurns: 8, maxToolCalls: 4,
      onEvent: event => { if (event.reasoningDiagnostic) diagnostics.push({ phase: event.reasoningDiagnostic.phase, stage: event.reasoningDiagnostic.stage }); },
      executor: { listTools: () => [schema('local.read', 'Read the active account from the authorized local provider')],
        execute: async candidate => {
          executed.push(candidate);
          // The planner becomes usable only after investigation has started, so
          // turn one must have run under the provisional contract.
          plannerUsable = true;
          return { success: true, output: 'observed', sources: [source('observed', 'local_machine')] };
        } } });

    expect(diagnostics).toEqual(expect.arrayContaining([{ phase: 'plan', stage: 'fallback' }]));
    expect(diagnostics.some(diagnostic => diagnostic.stage === 'blocked')).toBe(false);
    // Turn one reached the reasoning/tool loop rather than stopping before it.
    expect(executed.map(candidate => candidate.arguments.profile)).toEqual(['first', 'second']);
    expect(result.completionState).toBe('GOAL_COMPLETE');
    expect(result.answer).not.toContain('fabricated');
    // Evidence observed under the provisional contract was rebound, so only
    // evidence re-observed against the audited contract completed the run.
    const state = result.workingState.reasoning!;
    expect(state.planning).toMatchObject({ status: 'ready' });
    expect(state.evidence.filter(item => !item.accepted).map(item => item.rejection))
      .toContain('Observed under a provisional contract; needs binding to an audited requirement.');
    expect(reasoningAcceptance(state, goal).ok).toBe(true);
  });

  it('never certifies completion or acceptance while the contract is provisional', async () => {
    const goal = 'Observe the active local account';
    const controller = new ReasoningController({ goal, provider: contractBoundProvider(() => response('{bad-json')),
      model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2 });
    await controller.initialize();
    expect(controller.planningStatus()).toBe('provisional');
    expect(controller.state.requiredEvidence).toHaveLength(1);
    const candidate = call('local.read');
    const action = (await controller.assess(candidate, schema(candidate.name))).action!;
    await controller.observe(candidate, { success: true, output: 'observed', sources: [source('observed', 'local_machine')] }, action);
    // The observation is recorded, but an unaudited requirement is never met.
    expect(controller.state.evidence.some(item => item.accepted)).toBe(true);
    expect(controller.unresolved()).toHaveLength(1);
    const review = await controller.verify('TASK_COMPLETE: observed');
    expect(review.ok).toBe(false);
    expect(review.reason).toContain('provisional');
    expect(reasoningAcceptance(controller.state, goal)).toMatchObject({ ok: false });
    // Further investigation stays admissible instead of being refused as done.
    expect((await controller.assess(call('local.other'), schema('local.other'))).ok).toBe(true);
  });

  it('retains validated draft requirements when only the independent audit is unusable', async () => {
    const goal = 'Observe the active identifier and configuration';
    const valid = controllerProvider([requirement(goal, 'identifier'), requirement(goal, 'configuration')]);
    const controller = new ReasoningController({ goal, model: 'mock', maxTurns: 8, maxToolCalls: 4, reserveTurns: 2,
      provider: { chat: async request => isPhase(request, 'plan_audit') ? response('not json at all') : valid.chat(request) } });
    await controller.initialize();
    expect(controller.planningStatus()).toBe('provisional');
    expect(controller.state.requiredEvidence.map(item => item.id)).toEqual(['identifier', 'configuration']);
    expect(controller.state.successCondition).not.toContain('needs audit');
  });

  it('reports a genuine blocker for a request that cannot be planned or investigated', async () => {
    let calls = 0;
    const stages: string[] = [];
    const blank = await runAgentLoop({ model: 'mock', capabilities: { toolCalling: 'verified', streaming: 'unsupported' },
      provider: primaryProvider([response('TASK_COMPLETE: fabricated')], { chat: async () => response('{bad-json') }),
      executor: { listTools: () => [schema('local.read')], execute: async () => { calls += 1; return { success: true, output: 'value' }; } },
      prompt: '   ', onEvent: event => { if (event.reasoningDiagnostic) stages.push(event.reasoningDiagnostic.stage); } });
    expect(blank.completionState).toBe('BLOCKED');
    expect(blank.answer).toContain('no goal to investigate');
    expect(blank.answer).not.toContain('fabricated');
    expect(calls).toBe(0);
    expect(stages).toContain('blocked');
  });

  it('blocks a persistently unusable planner only after investigation has run', async () => {
    const goal = 'Observe the active local account';
    const executed: NormalizedToolCall[] = [];
    const result = await runAgentLoop({ model: 'mock', capabilities: { toolCalling: 'verified', streaming: 'unsupported' },
      provider: primaryProvider([response('', [call('local.read')]), response('TASK_COMPLETE: fabricated')],
        contractBoundProvider(() => response('{bad-json'))),
      executor: { listTools: () => [schema('local.read', 'Read the active account from the authorized local provider')],
        execute: async candidate => { executed.push(candidate); return { success: true, output: 'observed', sources: [source('observed', 'local_machine')] }; } },
      prompt: goal, maxTurns: 8, maxToolCalls: 4 });
    expect(executed).toHaveLength(1);
    expect(result.completionState).toBe('BLOCKED');
    expect(result.answer).toMatch(/^TASK_BLOCKED:/);
    expect(result.answer).toContain('audited evidence contract');
    expect(result.answer).not.toContain('fabricated');
    expect(reasoningAcceptance(result.workingState.reasoning, goal).ok).toBe(false);
  });

  it('keeps mixed search-result provenance and prevents a fixture path from being relabeled local state', () => {
    const mixed = sourcesForResult(call('filesystem.search'), { output: JSON.stringify({ matches: [{ path: 'docs/demo.md', line: 'wallet:0xabc' }, { path: 'tests/a.test.ts', line: 'fake' }, { path: 'src/main.ts', line: 'code' }] }) });
    expect(mixed.map(s => s.provenance)).toEqual(['documentation', 'fixture', 'repository_code']);
    expect(sourcesForResult(call('local.read'), { output: 'fake', sources: [source('fake', 'local_machine', 'tests/a.ts')] })[0].provenance).toBe('fixture');
  });

  it('contains no scenario-specific production branch or workflow', () => {
    for (const file of ['reasoning-controller.ts', 'evidence-provenance.ts']) {
      const contents = readFileSync(new URL(`../packages/agent-core/src/${file}`, import.meta.url), 'utf8');
      expect(contents).not.toMatch(/metamask|wallet:0xabc|laboratory|instrument/i);
    }
  });
});
