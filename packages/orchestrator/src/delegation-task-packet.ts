export interface DelegationTaskPacket {
  objective: string;
  relevantFiles: string[];
  relevantSymbols: string[];
  repositoryFacts: string[];
  constraints: string[];
  expectedResult: string;
  parentThreadId?: string;
}

export function createDelegationTaskPacket(
  packet: Partial<DelegationTaskPacket> &
    Pick<DelegationTaskPacket, 'objective'>,
): DelegationTaskPacket {
  return {
    objective: packet.objective,
    relevantFiles: packet.relevantFiles ?? [],
    relevantSymbols: packet.relevantSymbols ?? [],
    repositoryFacts: packet.repositoryFacts ?? [],
    constraints: packet.constraints ?? [],
    expectedResult:
      packet.expectedResult ??
      'Return concise findings and objective evidence.',
    parentThreadId: packet.parentThreadId,
  };
}
