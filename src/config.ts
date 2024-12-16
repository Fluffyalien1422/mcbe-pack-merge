import { z } from "zod";

export const configValidator = z.object({
  input: z
    .object({
      dir: z.string(),
    })
    .or(
      z.object({
        packs: z.array(z.string()),
      })
    ),
  outDir: z.string(),
  duplicateIdentifierWarnings: z.boolean().optional(),
});

export type Config = z.infer<typeof configValidator>;
