/**
 * oRPC Handler — Hono integration
 *
 * Creates an RPCHandler from the facts router and exports a Hono middleware
 * function to mount at a given prefix (e.g. /rpc/facts/*).
 */

import { RPCHandler } from "@orpc/server/fetch";
import { onError } from "@orpc/server";
import type { Context, Next } from "hono";
import { factsRouter } from "./facts-router.js";

const rpcHandler = new RPCHandler(factsRouter, {
  interceptors: [
    onError((error) => {
      console.error("[oRPC] Unhandled error:", error);
    }),
  ],
});

/**
 * Hono middleware that routes oRPC requests under the given prefix.
 * Mount with: app.use('/rpc/facts/*', orpcFactsMiddleware('/rpc/facts'))
 */
export function createOrpcFactsMiddleware(prefix: `/${string}`) {
  return async (c: Context, next: Next) => {
    const { matched, response } = await rpcHandler.handle(c.req.raw, {
      prefix,
      context: {},
    });

    if (matched) {
      return c.newResponse(response.body, response);
    }

    await next();
  };
}
