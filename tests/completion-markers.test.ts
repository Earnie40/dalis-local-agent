import { describe, expect, it } from 'vitest';
import {
  detectCompletionMarker,
  hasCompletionMarker,
  hasCompletionSignal,
  stripCompletionMarker,
} from '../packages/agent-core/src/completion-markers';

describe('completion marker declarations', () => {
  it.each([
    'TASK_COMPLETE: reported the kernel string.',
    'TASK_COMPLETE:reported the kernel string.',
    'TASK_COMPLETE',
    'TASK_COMPLETE.',
    'TASK_COMPLETE!',
    'TASK_COMPLETE. The kernel is Linux 6.6.',
    '**TASK_COMPLETE**',
    '**TASK_COMPLETE**: reported the kernel string.',
    '**TASK_COMPLETE:** reported the kernel string.',
    '**TASK_COMPLETE.**',
    '*TASK_COMPLETE*',
    '__TASK_COMPLETE__',
    '`TASK_COMPLETE`',
    '## TASK_COMPLETE',
    '### **TASK_COMPLETE**',
    'TASK_COMPLETE — the command ran inside WSL.',
    'TASK_COMPLETE – the command ran inside WSL.',
    'TASK_COMPLETE - the command ran inside WSL.',
    '**TASK_COMPLETE** — the command ran inside WSL.',
    'The kernel string is Linux 6.6.\n\n**TASK_COMPLETE**',
    'The kernel string is Linux 6.6.\r\n\r\n**TASK_COMPLETE**\r\n',
    '  TASK_COMPLETE: indented declaration.',
  ])('accepts %j as a declaration', (content) => {
    expect(hasCompletionMarker(content, 'TASK_COMPLETE')).toBe(true);
    expect(hasCompletionSignal(content)).toBe(true);
  });

  it.each([
    'I will emit TASK_COMPLETE when the command has run.',
    'TASK_COMPLETE is the marker I return once verified.',
    'TASK_COMPLETE only after every requested outcome is verified.',
    'Return TASK_COMPLETE: only after verification.',
    'TASK_COMPLETED the run.',
    'TASK_COMPLETE_V2: not a marker.',
    'TASK_COMPLETE-ish behaviour is not a declaration.',
    'Status: TASK_COMPLETE',
    '- TASK_COMPLETE means the work is verified.',
    '',
  ])('does not treat %j as a declaration', (content) => {
    expect(hasCompletionMarker(content, 'TASK_COMPLETE')).toBe(false);
    expect(detectCompletionMarker(content)).toBeUndefined();
  });

  it('recognizes the same formatting variants for every marker', () => {
    expect(hasCompletionMarker('**TASK_BLOCKED**', 'TASK_BLOCKED')).toBe(true);
    expect(hasCompletionMarker('**TASK_BLOCKED:** wsl.run is not selected.', 'TASK_BLOCKED')).toBe(true);
    expect(hasCompletionMarker('`TASK_WAITING_FOR_USER`', 'TASK_WAITING_FOR_USER')).toBe(true);
    expect(hasCompletionMarker('TASK_WAITING_FOR_USER: which distro?', 'TASK_WAITING_FOR_USER')).toBe(true);
    expect(hasCompletionSignal('**TASK_BLOCKED**')).toBe(true);
    expect(hasCompletionSignal('TASK_WAITING_FOR_USER: which distro?')).toBe(false);
  });

  it('never confuses one marker for another', () => {
    expect(hasCompletionMarker('**TASK_BLOCKED**', 'TASK_COMPLETE')).toBe(false);
    expect(hasCompletionMarker('TASK_COMPLETE: done', 'TASK_BLOCKED')).toBe(false);
  });

  it('keeps the waiting > blocked > complete precedence', () => {
    expect(detectCompletionMarker('TASK_COMPLETE: partially.\nTASK_BLOCKED: credentials missing.')).toBe('TASK_BLOCKED');
    expect(detectCompletionMarker('TASK_BLOCKED: choose.\nTASK_WAITING_FOR_USER: which?')).toBe('TASK_WAITING_FOR_USER');
    expect(detectCompletionMarker('**TASK_COMPLETE**')).toBe('TASK_COMPLETE');
  });

  it('strips a leading declaration and its formatting from the answer', () => {
    expect(stripCompletionMarker('TASK_COMPLETE: COMPLETED — kernel reported.')).toBe('COMPLETED — kernel reported.');
    expect(stripCompletionMarker('**TASK_BLOCKED:** wsl.run is not selected.')).toBe('wsl.run is not selected.');
    expect(stripCompletionMarker('**TASK_COMPLETE**\n\nKernel: Linux 6.6.')).toBe('Kernel: Linux 6.6.');
    expect(stripCompletionMarker('TASK_COMPLETE — kernel reported.')).toBe('kernel reported.');
    // Prose is left alone: nothing to strip.
    expect(stripCompletionMarker('I will emit TASK_COMPLETE when done.')).toBe('I will emit TASK_COMPLETE when done.');
  });
});
