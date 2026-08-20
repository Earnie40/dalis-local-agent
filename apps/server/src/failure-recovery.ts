import {
  recallFailures,
  rememberFailure,
} from '@dacai-local-agent/memory';

export interface ToolFailureInput {
  tool: string;
  arguments: Record<string, unknown>;
  output: string;
  error?: string;
  threadId: string;
  turn: number;
}

export interface FailureRecovery {
  category: string;
  signature: string;
  correctiveAction: string;
  previousLessons: unknown[];
  message: string;
}

function compact(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 800);
}

function classify(
  input: ToolFailureInput,
): {
  category: string;
  correctiveAction: string;
} {
  const text = `${input.error ?? ''} ${input.output}`
    .toLowerCase();

  if (
    /permission|denied|not allowed|unauthorized|forbidden/.test(text)
  ) {
    return {
      category: 'permission-denied',
      correctiveAction:
        'Do not retry or route around the denied action. Use a permitted approach if one exists; otherwise treat the permission boundary as the blocker.',
    };
  }

  if (
    /enoent|not found|does not exist|cannot find|no such file/.test(text)
  ) {
    return {
      category: 'path-not-found',
      correctiveAction:
        'Stop guessing paths. Inspect the nearest known parent directory or use repository/symbol discovery to establish the real path before another read or edit.',
    };
  }

  if (
    /is a directory|eisdir/.test(text)
  ) {
    return {
      category: 'directory-used-as-file',
      correctiveAction:
        'Use filesystem.list on the directory, identify the actual file, then read that file. Do not repeat filesystem.read against the directory.',
    };
  }

  if (
    /duplicate call/.test(text)
  ) {
    return {
      category: 'duplicate-call',
      correctiveAction:
        'Use the prior result already in context. Change the investigation strategy instead of repeating the same call.',
    };
  }

  if (
    /zero matches|0 matches|no matches|nothing found/.test(text) &&
    input.tool === 'filesystem.search'
  ) {
    return {
      category: 'content-search-empty',
      correctiveAction:
        'Do not interpret zero content matches as proof a file does not exist. Use code.symbol.search, architecture context, or filesystem.list when filename/location discovery is needed.',
    };
  }

  if (
    /typescript|ts\d{4}|type error|typecheck|tsc/.test(text)
  ) {
    return {
      category: 'typescript-diagnostic',
      correctiveAction:
        'Inspect the exact diagnostic location and involved type/interface. Make the smallest type-correct change, then rerun only the relevant diagnostic before broader validation.',
    };
  }

  if (
    /test failed|tests failed|assert|expected|vitest|jest|failed tests?/.test(text)
  ) {
    return {
      category: 'test-failure',
      correctiveAction:
        'Inspect the failing assertion and the implementation it exercises. Determine whether the implementation or expectation is wrong, correct the responsible code, then rerun the targeted failing test.',
    };
  }

  if (
    /timeout|timed out|etimedout/.test(text)
  ) {
    return {
      category: 'timeout',
      correctiveAction:
        'Do not blindly repeat the same expensive operation. Reduce scope or use a more targeted tool/query first; retry only when the cause has been changed or the timeout is clearly transient.',
    };
  }

  if (
    /connection refused|econnrefused|unreachable|connection reset/.test(text)
  ) {
    return {
      category: 'service-unavailable',
      correctiveAction:
        'Treat this as an infrastructure/service-state issue. Verify the required local service or dependency rather than repeatedly issuing the same request.',
    };
  }

  if (
    input.tool === 'code.diagnostics'
  ) {
    return {
      category: 'diagnostic-failure',
      correctiveAction:
        'Read the exact affected source and diagnostic details, correct the responsible implementation, then rerun code.diagnostics on the narrowest relevant scope.',
    };
  }

  if (
    input.tool === 'tests.run'
  ) {
    return {
      category: 'validation-failure',
      correctiveAction:
        'Use the failing validation output as evidence. Inspect the responsible source/test pair, make a targeted correction, and rerun the narrow validation before escalating.',
    };
  }

  return {
    category: 'tool-failure',
    correctiveAction:
      'Use the actual error as evidence. Do not repeat the same approach unchanged. Inspect a narrower prerequisite or choose a different tool that resolves the cause of this failure.',
  };
}

export async function buildFailureRecovery(
  input: ToolFailureInput,
): Promise<FailureRecovery> {
  const classified =
    classify(input);

  const signature =
    compact(
      `${classified.category}: ${
        input.error ??
        input.output ??
        'unknown failure'
      }`,
    );

  let previousLessons: unknown[] = [];

  try {
    previousLessons =
      await recallFailures(
        input.tool,
        signature,
        5,
      );
  } catch {
    previousLessons = [];
  }

  try {
    await rememberFailure({
      operation: input.tool,
      errorSignature: signature,

      attemptedApproach:
        `${input.tool} ${JSON.stringify(input.arguments).slice(0, 600)}`,

      correctiveAction:
        classified.correctiveAction,

      outcome: 'failed',

      metadata: {
        threadId: input.threadId,
        turn: input.turn,
        category: classified.category,
      },
    });
  } catch {
    // Recovery advice must still work if memory persistence is unavailable.
  }

  const lessonText =
    previousLessons.length
      ? [
          '',
          'Relevant prior failure lessons:',
          JSON.stringify(
            previousLessons.slice(0, 5),
            null,
            2,
          ).slice(0, 5000),
        ].join('\n')
      : '';

  const message = [
    'SELF-CORRECTION REQUIRED:',
    `Failed tool: ${input.tool}`,
    `Failure category: ${classified.category}`,
    `Observed failure: ${compact(input.output || input.error || 'unknown')}`,
    '',
    `Required strategy change: ${classified.correctiveAction}`,
    '',
    'Do not repeat the failed approach unchanged.',
    'Use the failure evidence and any recalled lessons to choose the next materially different action.',
    lessonText,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    category:
      classified.category,

    signature,

    correctiveAction:
      classified.correctiveAction,

    previousLessons,

    message,
  };
}
