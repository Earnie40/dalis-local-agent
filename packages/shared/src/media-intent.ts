import { z } from 'zod';

/** A model-independent contract. Routing never parses appended preservation prose. */
export const MediaRegionSchema = z.object({
  left: z.number().min(0).max(1), top: z.number().min(0).max(1),
  right: z.number().min(0).max(1), bottom: z.number().min(0).max(1),
}).strict().refine((box) => box.right > box.left && box.bottom > box.top, 'The target region must have positive area.');

export const MediaIntentSchema = z.object({
  version: z.literal(1),
  kind: z.enum(['image', 'video']),
  operation: z.enum(['generate', 'edit']),
  editScope: z.enum(['localized', 'global', 'none']),
  instruction: z.string().trim().min(1).max(4000),
  changes: z.array(z.object({
    action: z.string().trim().min(1).max(1000),
    target: z.string().trim().min(1).max(500),
    region: MediaRegionSchema.optional(),
  }).strict()).min(1).max(24),
  protectedAttributes: z.array(z.string().trim().min(1).max(500)).max(40),
  requiresBodyGeometry: z.boolean(),
  changesPose: z.boolean(),
  constraints: z.object({
    width: z.number().int().min(256).max(1536).optional(),
    height: z.number().int().min(256).max(1536).optional(),
    durationSeconds: z.number().min(1).max(1800).optional(),
    loop: z.boolean().default(false),
    subjects: z.array(z.object({
      description: z.string().trim().min(1).max(500),
      count: z.number().int().min(0).max(1000),
      placement: z.string().trim().min(1).max(500).optional(),
    }).strict()).max(24).default([]),
    explicit: z.array(z.string().trim().min(1).max(1000)).max(40).default([]),
  }).strict(),
}).strict().superRefine((intent, context) => {
  if (intent.operation === 'generate' && intent.editScope !== 'none') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Generation has no source edit scope.', path: ['editScope'] });
  }
  if (intent.operation === 'edit' && intent.editScope === 'none') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An edit must declare its scope.', path: ['editScope'] });
  }
  if (intent.editScope === 'localized' && intent.changes.some((change) => !change.region)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Every localized change requires a visually grounded target region.', path: ['changes'] });
  }
});

export type MediaIntent = z.infer<typeof MediaIntentSchema>;
export type MediaRegion = z.infer<typeof MediaRegionSchema>;
export function parseMediaIntent(value: unknown): MediaIntent { return MediaIntentSchema.parse(value); }

const CheckSchema = z.object({
  passed: z.boolean(), evidence: z.string().trim().min(1).max(1600),
}).strict();

/** All booleans are required and strictly typed; unknown/malformed is never a pass. */
export const MediaVerificationSchema = z.object({
  requestedChanges: z.array(CheckSchema).min(1).max(24),
  protectedAttributes: z.array(CheckSchema).max(40),
  explicitConstraints: z.array(CheckSchema).max(40),
  subjects: CheckSchema,
  composition: CheckSchema,
  temporalProgression: CheckSchema,
  summary: z.string().trim().min(1).max(2000),
  correction: z.string().trim().max(2000),
}).strict();
export type MediaVerification = z.infer<typeof MediaVerificationSchema>;

export function mediaVerificationPassed(report: MediaVerification, intent: MediaIntent): boolean {
  if (report.requestedChanges.length !== intent.changes.length ||
      report.protectedAttributes.length !== intent.protectedAttributes.length ||
      report.explicitConstraints.length !== intent.constraints.explicit.length) return false;
  return [...report.requestedChanges, ...report.protectedAttributes, ...report.explicitConstraints,
    report.subjects, report.composition, report.temporalProgression].every((check) => check.passed);
}
