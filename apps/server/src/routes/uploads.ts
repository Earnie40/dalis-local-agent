import type { FastifyInstance } from 'fastify';
import { PostgresWorkspaceRegistry } from '@dacai-local-agent/workspace';
import {
  listUploads,
  MAX_UPLOAD_BYTES,
  removeUpload,
  saveUpload,
  UploadError,
} from '../workspace-uploads';

function uploadFailure(error: unknown): { status: number; message: string } {
  if (error instanceof UploadError) return { status: error.statusCode, message: error.message };
  return { status: 500, message: 'The upload could not be stored.' };
}

/**
 * Workspace-scoped file uploads shared by the chat, agent and studio
 * composers. Files are written inside the registered workspace root so the
 * agent's ordinary filesystem tools can read them by relative path; nothing
 * here reads or executes the uploaded content.
 */
export function registerUploadRoutes(server: FastifyInstance): void {
  const workspaces = new PostgresWorkspaceRegistry();

  server.get<{ Params: { id: string } }>(
    '/api/workspaces/:id/uploads',
    async (request, reply) => {
      const workspace = await workspaces.get(request.params.id);
      if (!workspace) return reply.code(404).send({ error: 'Workspace not found.' });
      return { uploads: await listUploads(workspace.rootPath) };
    },
  );

  server.post<{ Params: { id: string } }>(
    '/api/workspaces/:id/uploads',
    async (request, reply) => {
      const workspace = await workspaces.get(request.params.id);
      if (!workspace) return reply.code(404).send({ error: 'Workspace not found.' });

      if (!request.isMultipart()) {
        return reply.code(415).send({ error: 'Send the file as multipart/form-data.' });
      }

      try {
        const uploads = [];
        for await (const part of request.files()) {
          // toBuffer() throws once the per-file limit configured on the
          // multipart plugin is exceeded, which is caught below.
          const content = await part.toBuffer();
          uploads.push(await saveUpload(workspace, { fileName: part.filename, content }));
        }

        if (uploads.length === 0) {
          return reply.code(400).send({ error: 'No file was included in the request.' });
        }
        return { uploads };
      } catch (error) {
        const failure = uploadFailure(error);
        if (failure.status >= 500) {
          request.log.error(
            { error: error instanceof Error ? error.message : String(error) },
            'workspace upload failed',
          );
        }
        return reply.code(failure.status).send({ error: failure.message });
      }
    },
  );

  server.delete<{ Params: { id: string; uploadId: string } }>(
    '/api/workspaces/:id/uploads/:uploadId',
    async (request, reply) => {
      const workspace = await workspaces.get(request.params.id);
      if (!workspace) return reply.code(404).send({ error: 'Workspace not found.' });
      if (!workspace.capabilities.write) {
        return reply.code(403).send({ error: 'This workspace is read-only.' });
      }

      try {
        await removeUpload(workspace.rootPath, request.params.uploadId);
        return { ok: true };
      } catch (error) {
        const failure = uploadFailure(error);
        return reply.code(failure.status).send({ error: failure.message });
      }
    },
  );

  server.get('/api/uploads/limits', async () => ({
    maxBytes: MAX_UPLOAD_BYTES,
  }));
}
