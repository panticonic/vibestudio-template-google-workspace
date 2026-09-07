import { z } from "zod";

export const customCommandSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  openInNewPane: z.boolean().optional(),
  splitDirection: z.enum(["right", "down"]).optional(),
});

export const customCommandsFileSchema = z.object({
  commands: z.array(customCommandSchema).default([]),
});

export type CustomCommand = z.infer<typeof customCommandSchema>;
