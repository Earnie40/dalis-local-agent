import { existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createId, getPool } from '@dacai-local-agent/shared';
import type { WorkspaceDescriptor, WorkspaceInput, WorkspaceRegistry } from './types';
import type { WorkspaceCapabilities } from '@dacai-local-agent/security';

interface WorkspaceRow {
  id: string;
  display_name: string;
  root_path: string;
  read_access: boolean;
  write_access: boolean;
  shell_access: boolean;
  network_access: boolean;
  project_instructions: string | null;
  memory_namespace: string | null;
  git_detected: boolean;
  detected_languages: string[];
  created_at: Date;
  updated_at: Date;
}

function toDescriptor(row: WorkspaceRow): WorkspaceDescriptor {
  return {
    id: row.id,
    displayName: row.display_name,
    rootPath: row.root_path,
    capabilities: {
      read: row.read_access,
      write: row.write_access,
      shell: row.shell_access,
      network: row.network_access,
    },
    gitDetected: row.git_detected,
    detectedLanguages: row.detected_languages,
    projectInstructions: row.project_instructions ?? undefined,
    memoryNamespace: row.memory_namespace ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Best-effort project detection so the UI can show what a workspace contains. */
export async function detectProject(rootPath: string): Promise<{ gitDetected: boolean; languages: string[] }> {
  const gitDetected = existsSync(join(rootPath, '.git'));
  const languages = new Set<string>();

  const manifests: Array<[string, string]> = [
    ['package.json', 'javascript/typescript'],
    ['tsconfig.json', 'typescript'],
    ['Cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['pom.xml', 'java'],
    ['build.gradle', 'java/kotlin'],
    ['Gemfile', 'ruby'],
    ['composer.json', 'php'],
    ['*.csproj', 'dotnet'],
  ];

  let entries: string[] = [];
  try {
    entries = await readdir(rootPath);
  } catch {
    return { gitDetected, languages: [] };
  }

  for (const [manifest, language] of manifests) {
    if (manifest.startsWith('*')) {
      const ext = manifest.slice(1);
      if (entries.some((e) => e.endsWith(ext))) languages.add(language);
    } else if (entries.includes(manifest)) {
      languages.add(language);
    }
  }

  return { gitDetected, languages: [...languages] };
}

export class PostgresWorkspaceRegistry implements WorkspaceRegistry {
  async list(): Promise<WorkspaceDescriptor[]> {
    const { rows } = await getPool().query<WorkspaceRow>(
      'SELECT * FROM workspaces ORDER BY updated_at DESC',
    );
    return rows.map(toDescriptor);
  }

  async get(id: string): Promise<WorkspaceDescriptor | undefined> {
    const { rows } = await getPool().query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = $1', [id]);
    return rows[0] ? toDescriptor(rows[0]) : undefined;
  }

  async updateCapabilities(id: string, capabilities: WorkspaceCapabilities): Promise<WorkspaceDescriptor | undefined> {
    const { rows } = await getPool().query<WorkspaceRow>(
      `UPDATE workspaces
          SET read_access = $2,
              write_access = $3,
              shell_access = $4,
              network_access = $5,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, capabilities.read, capabilities.write, capabilities.shell, capabilities.network],
    );
    return rows[0] ? toDescriptor(rows[0]) : undefined;
  }

  async create(workspace: WorkspaceInput): Promise<WorkspaceDescriptor> {
    const rootPath = resolve(workspace.rootPath);

    if (!existsSync(rootPath) || !statSync(rootPath).isDirectory()) {
      throw new Error(`Workspace root does not exist or is not a directory: ${rootPath}`);
    }

    const detected = await detectProject(rootPath);
    const id = createId('ws');

    const { rows } = await getPool().query<WorkspaceRow>(
      `INSERT INTO workspaces (
         id, display_name, root_path, read_access, write_access, shell_access,
         network_access, project_instructions, memory_namespace, git_detected, detected_languages
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (root_path) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         read_access = EXCLUDED.read_access,
         write_access = EXCLUDED.write_access,
         shell_access = EXCLUDED.shell_access,
         network_access = EXCLUDED.network_access,
         project_instructions = EXCLUDED.project_instructions,
         updated_at = now()
       RETURNING *`,
      [
        id,
        workspace.displayName,
        rootPath,
        workspace.capabilities.read,
        workspace.capabilities.write,
        workspace.capabilities.shell,
        workspace.capabilities.network,
        workspace.projectInstructions ?? null,
        workspace.memoryNamespace ?? null,
        workspace.gitDetected ?? detected.gitDetected,
        JSON.stringify(workspace.detectedLanguages ?? detected.languages),
      ],
    );

    return toDescriptor(rows[0]);
  }

  async remove(id: string): Promise<void> {
    await getPool().query('DELETE FROM workspaces WHERE id = $1', [id]);
  }
}
