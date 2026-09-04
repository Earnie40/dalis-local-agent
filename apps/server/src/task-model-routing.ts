import type { TaskRecord } from '@dacai-local-agent/orchestrator';
import type { ProviderRegistry, ResolvedModel } from '@dacai-local-agent/providers';

type TaskRoute = Pick<TaskRecord, 'modelAlias' | 'providerInstanceId' | 'model'>;
type ModelResolver = Pick<ProviderRegistry, 'resolveAlias' | 'resolve'>;

/** Resolve durable routing intent at execution time, with legacy-row compatibility. */
export async function resolveTaskModel(task: TaskRoute, registry: ModelResolver): Promise<ResolvedModel> {
  if (task.modelAlias) {
    return registry.resolveAlias(task.modelAlias, { requireToolCalling: true });
  }
  return registry.resolve(task.providerInstanceId, task.model, { requireToolCalling: true });
}
