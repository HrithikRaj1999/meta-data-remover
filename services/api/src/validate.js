/**
 * Zod schemas:
 * Why: never trust browser input; validate sizes/types to avoid abuse and bugs.
 */
import { z } from "zod";

export const PresignSchema = z.object({
  fileName: z.string().min(1).max(300),
  contentType: z.string().min(1).max(100),
});

export const EditSchema = z
  .object({
    author: z.string().max(200).optional(),
    title: z.string().max(200).optional(),
    subject: z.string().max(200).optional(),
    keywords: z.string().max(500).optional(),
    creator: z.string().max(200).optional(),
    producer: z.string().max(200).optional(),
  })
  .optional();

export const CreateJobSchema = z.object({
  // In production use real auth (Cognito/JWT) and derive userId from token.
  userId: z.string().min(1).max(100),
  items: z
    .array(
      z.object({
        inputKey: z.string().min(1).max(1024),
        operation: z.enum(["REMOVE", "EDIT"]),
        edit: EditSchema,
      })
    )
    .min(1)
    .max(3000),
});
