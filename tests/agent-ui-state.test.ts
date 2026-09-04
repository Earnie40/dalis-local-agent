import { describe, expect, it } from 'vitest';
import {
  agentConversationHistory,
  chooseAgentWorkspace,
  selectableAgentModels,
} from '../apps/web/src/agent-ui-state';
import type { ModelAlias, Workspace } from '../apps/web/src/api';

const workspaces: Workspace[] = [
  {
    id: 'avatar', displayName: 'AVATAR-VIDEO GEN', rootPath: 'C:\\projects\\avatar',
    capabilities: { read: true, write: true, shell: true, network: true },
    gitDetected: true, detectedLanguages: ['javascript/typescript'],
  },
  {
    id: 'dacai', displayName: 'DacaiLocalAgent', rootPath: 'C:\\Users\\Kyleh\\DacaiLocalAgent',
    capabilities: { read: true, write: true, shell: true, network: true },
    gitDetected: true, detectedLanguages: ['javascript/typescript'],
  },
];

describe('agent UI state', () => {
  it('keeps a valid workspace preference and otherwise prefers the product workspace', () => {
    expect(chooseAgentWorkspace(workspaces, 'avatar')).toBe('avatar');
    expect(chooseAgentWorkspace(workspaces, 'missing')).toBe('dacai');
  });

  it('removes models known to be unable to call tools', () => {
    const aliases: ModelAlias[] = [
      { alias: 'coder', providerInstanceId: 'local', model: 'qwen', enabled: true, agentCapability: 'verified' },
      { alias: 'fast', providerInstanceId: 'local', model: 'phi3', enabled: true, agentCapability: 'unsupported' },
      { alias: 'claude', providerInstanceId: 'cloud', model: 'opus', enabled: true, agentCapability: 'declared' },
    ];
    expect(selectableAgentModels(aliases, {}).map((entry) => entry.alias)).toEqual(['coder', 'claude']);
  });

  it('carries only visible conversation turns into a follow-up run', () => {
    expect(agentConversationHistory([
      { type: 'user_prompt', content: 'Inspect the router.' },
      { type: 'tool_call', tool: 'filesystem.read' },
      { type: 'done', answer: 'The router selects a provider.' },
    ])).toEqual([
      { role: 'user', content: 'Inspect the router.' },
      { role: 'assistant', content: 'The router selects a provider.' },
    ]);
  });
});
