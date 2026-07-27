import type { NextFunction, Request, Response } from "express";
import type { ValidationError } from "@oaverify/internal-core";

/**
 * The trio every Express 4 middleware receives. Passed to user-supplied
 * `onError` callbacks so they can render their own response, call
 * `next(err)`, or whatever the host app's error contract requires.
 *
 * Identical in shape to what an inline middleware would close over;
 * the type is exported only so users can annotate their callbacks.
 *
 * @public
 */
export interface ExpressContext {
  req: Request;
  res: Response;
  next: NextFunction;
}

/**
 * Signature shared by `onError` on every adapter in the family
 * (`@oaverify/express4`, `@oaverify/express5`, `@oaverify/fastify`). The `Ctx`
 * parameter is the only thing that varies; same name and shape
 * everywhere.
 *
 * Returning a Promise is supported on every adapter. `@oaverify/express4`
 * awaits the return so async work (logging to a remote service,
 * loading per-tenant rendering config, etc.) can complete before the
 * middleware exits. Sync handlers pay no measurable overhead.
 *
 * `errors` is the flat list of failing leaves, regardless of the
 * validator's `output` mode (a tree validator's result is flattened
 * before the handler is called).
 *
 * @public
 */
export type ErrorHandler<Ctx> = (errors: ValidationError[], ctx: Ctx) => void | Promise<void>;
