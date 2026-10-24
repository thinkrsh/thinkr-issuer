// Reads the JSON body of a request and checks it against a schema, or throws an IssuerError.
import type { Context } from 'hono';
import type { z } from 'zod';

import { MESSAGES } from '../config/messages.js';
import { IssuerError } from './errors.js';

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json<unknown>();
  } catch (error) {
    if (error instanceof SyntaxError) throw new IssuerError('invalid_request', MESSAGES.notJson);
    throw error;
  }
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new IssuerError('invalid_request', describeIssue(result.error));
  return result.data;
}

/** The first problem of a body, with the path of the field that has it. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return MESSAGES.invalidRequest;
  const path = issue.path.map(String).join('.');
  return path === '' ? issue.message : `${path}: ${issue.message}`;
}
