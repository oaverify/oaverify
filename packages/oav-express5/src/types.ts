import type { NextFunction, Request, Response } from "express";
import type { ValidationError } from "@oaverify/internal-core";

/**
 * The trio every Express 5 middleware receives. Passed to user-supplied
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
 * (`oav-express4`, `oav-express5`, `oav-fastify`). The `Ctx`
 * parameter is the only thing that varies; same name and shape
 * everywhere.
 *
 * Returning a Promise is supported on every adapter. `oav-express5`
 * awaits the return; rejected promises propagate through Express 5's
 * native promise handling to the host's error middleware.
 *
 * `errors` is the flat list of failing leaves, regardless of the
 * validator's `output` mode (a tree validator's result is flattened
 * before the handler is called).
 *
 * @public
 */
export type ErrorHandler<Ctx> = (errors: ValidationError[], ctx: Ctx) => void | Promise<void>;
