import type { WorkspaceCapabilities } from '@dacai-local-agent/security';

export interface WorkspaceDescriptor {
  id: string;
  displayName: string;
  rootPath: string;
  capabilities: WorkspaceCapabilities;
  gitDetected: boolean;
  detectedLanguages: string[];
  projectInstructions?: string;
  memoryNamespace?: string;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceInput = Omit<
  WorkspaceDescriptor,
  'id' | 'createdAt' | 'updatedAt' | 'gitDetected' | 'detectedLanguages'
> & {
  gitDetected?: boolean;
  detectedLanguages?: string[];
};

export interface WorkspaceRegistry {
  list(): Promise<WorkspaceDescriptor[]>;
  create(workspace: WorkspaceInput): Promise<WorkspaceDescriptor>;
  get(id: string): Promise<WorkspaceDescriptor | undefined>;
  updateCapabilities(id: string, capabilities: WorkspaceCapabilities): Promise<WorkspaceDescriptor | undefined>;
  remove(id: string): Promise<void>;
}
