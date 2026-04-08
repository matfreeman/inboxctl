import { z } from "zod";

export const RuleNameSchema = z
  .string()
  .min(1, "Rule name is required")
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Rule name must be kebab-case (lowercase letters, numbers, and single hyphens)",
  );

export const RuleFieldSchema = z.enum(["from", "to", "subject", "snippet", "labels"]);

const RegexStringSchema = z
  .string()
  .min(1, "Pattern must not be empty")
  .superRefine((value, ctx) => {
    try {
      new RegExp(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

export const MatcherSchema = z
  .object({
    // `snippet` is the only cached free-text matcher in MVP.
    field: RuleFieldSchema,
    pattern: RegexStringSchema.optional(),
    contains: z.array(z.string().min(1)).min(1).optional(),
    values: z.array(z.string().min(1)).min(1).optional(),
    exclude: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.pattern && !value.contains && !value.values) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Matcher must provide at least one of pattern, contains, or values",
        path: ["pattern"],
      });
    }
  });

export const ConditionsSchema = z
  .object({
    operator: z.enum(["AND", "OR"]),
    matchers: z.array(MatcherSchema).min(1, "At least one matcher is required"),
  })
  .strict();

const LabelActionSchema = z.object({
  type: z.literal("label"),
  label: z.string().min(1, "Label name is required"),
});

const ArchiveActionSchema = z.object({ type: z.literal("archive") });
const MarkReadActionSchema = z.object({ type: z.literal("mark_read") });
const ForwardActionSchema = z.object({
  type: z.literal("forward"),
  to: z.string().email("Forward destination must be a valid email address"),
});
const MarkSpamActionSchema = z.object({ type: z.literal("mark_spam") });

export const ActionSchema = z
  .discriminatedUnion("type", [
    LabelActionSchema,
    ArchiveActionSchema,
    MarkReadActionSchema,
    ForwardActionSchema,
    MarkSpamActionSchema,
  ]);

export const RuleSchema = z
  .object({
    name: RuleNameSchema,
    description: z.string(),
    enabled: z.boolean().default(true),
    priority: z.number().int().min(0).default(50),
    conditions: ConditionsSchema,
    actions: z.array(ActionSchema).min(1, "At least one action is required"),
  })
  .strict();

export function validateRule(input: unknown): Rule {
  return RuleSchema.parse(input);
}

export type Matcher = z.infer<typeof MatcherSchema>;
export type Conditions = z.infer<typeof ConditionsSchema>;
export type Action = z.infer<typeof ActionSchema>;
export type Rule = z.infer<typeof RuleSchema>;
