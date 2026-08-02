import { z } from "zod";
import { errorBody, okBody } from "../shared/schemas";

export const webhookOk = okBody;
export const webhookUnauthorized = errorBody;

/** Payload Linear — aceito como JSON genérico (HMAC valida o raw). */
export const webhookBody = z.record(z.string(), z.unknown()).optional();
