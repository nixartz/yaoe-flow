import { z } from "zod";

/** Resposta de erro padrão da API. */
export const errorBody = z.object({ error: z.string() });

/** `{ ok: true }` genérico. */
export const okBody = z.object({ ok: z.literal(true) });

export const idParam = z.object({ id: z.string().min(1) });

export const issueParam = z.object({ issue: z.string().min(1) });

export const keyParam = z.object({ key: z.string().min(1) });

/** Objeto JSON flexível (payloads dinâmicos / store). */
export const looseObject = z.record(z.string(), z.unknown());
