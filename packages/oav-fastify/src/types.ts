import type { FastifyReply, FastifyRequest } from "fastify";
import type { ValidationError } from "@oaverify/internal-core";

/**
 * The pair every Fastify hook receives. Passed to user-supplied
 * `onError` callbacks so they can render their own response or
 * delegate to Fastify's error handler.
 *
 * Identical in shape to what an inline hook would close over;
 * the type is exported only so users can annotate their callbacks.
 *
 * Pairs with `ExpressContext` from `oav-express4` / `oav-express5`.
 * Per-framework Context types use framework-native field names
 * (`request`/`reply` here vs `req`/`res`/`next` for Express); the
 * shape pattern is always "trigger + responder".
 *
 * @public
 */
export interface FastifyContext {
  request: FastifyRequest;
  reply: FastifyReply;
}

/**
 * Signature shared by `onError` on every adapter in the family
 * (`oav-express4`, `oav-express5`, `oav-fastify`). The `Ctx`
 * parameter is the only thing that varies; same name and shape
 * everywhere.
 *
 * Returning a Promise is supported on every adapter. `oav-fastify`
 * awaits the return; rejected promises propagate through Fastify's
 * native promise handling to its error handler.
 *
 * `errors` is the flat list of failing leaves, regardless of the
 * validator's `output` mode (a tree validator's result is flattened
 * before the handler is called).
 *
 * @public
 */
export type ErrorHandler<Ctx> = (errors: ValidationError[], ctx: Ctx) => void | Promise<void>;
