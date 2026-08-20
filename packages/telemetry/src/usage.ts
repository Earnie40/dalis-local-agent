import type { UsageClass } from '@dacai-local-agent/shared';
import type { UsageAggregate, UsageRecord } from './types';

const EMPTY_BY_CLASS: Record<UsageClass, number> = {
  LOCAL_OLLAMA: 0,
  REMOTE_GPU_OLLAMA: 0,
  HUGGING_FACE_REMOTE: 0,
  FUTURE_PAID_PROVIDER: 0,
};

export class UsageTracker {
  private readonly history: UsageRecord[] = [];

  record(entry: UsageRecord): void {
    this.history.push(entry);
  }

  summarize(): UsageAggregate {
    const byUsageClass = { ...EMPTY_BY_CLASS };
    let totalCost = 0;
    let totalToolCalls = 0;
    let fallbackEvents = 0;

    for (const item of this.history) {
      byUsageClass[item.usageClass] += 1;
      totalCost += item.estimatedCost;
      totalToolCalls += item.toolCalls;
      if (item.fallbackFromInstanceId) fallbackEvents += 1;
    }

    return {
      totalCost,
      totalRequests: this.history.length,
      totalToolCalls,
      sessions: new Set(this.history.map((record) => record.session)).size,
      byUsageClass,
      fallbackEvents,
    };
  }
}
