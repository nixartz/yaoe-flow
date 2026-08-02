import { z } from "zod";

export const createUserBody = z.object({
  name: z.string(),
  email: z.string().nullable().optional(),
  username: z.string(),
  password: z.string(),
});

export const updateUserBody = z.object({
  name: z.string().optional(),
  email: z.string().nullable().optional(),
  status: z.enum(["active", "inactive"]).optional(),
  password: z.string().optional(),
});

export const changePasswordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string(),
});
