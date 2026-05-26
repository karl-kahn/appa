// pattern: imperative-shell
// Auth helpers.
//
// The kernel does NOT include an authentication layer. Deployments must
// front it with one (Tailscale Funnel device-auth, reverse proxy with
// SSO, signed cookie middleware, etc.) and pass a `resolveCaller`
// implementation that converts whatever the proxy supplied into a
// `CallerIdentity`.
//
// For local development against an entirely-trusted environment, use
// `devAuth()` — it reads `asUserId` from the request body, query string,
// or X-Appa-User header and looks the id up in `team.json`. This is
// INSECURE BY DESIGN and prints a warning every time it's invoked.

import type { Request } from "express";
import type { ResolveCaller } from "../core/config.js";
import type { TeamReader } from "../core/team.js";
import { callerOwnsThread } from "../core/thread.js";
import type { CallerIdentity } from "../modules/types.js";

/**
 * Caller resolver that trusts a client-supplied `asUserId` POST body
 * field, X-Appa-User header, or `asUserId` query param. INTENDED FOR
 * LOCAL DEVELOPMENT ONLY. Do not use in any environment where the
 * server can be reached by an untrusted client. Prints a warning on
 * the first invocation of each process.
 */
export function devAuth(): ResolveCaller {
  let warned = false;
  return async (req: Request): Promise<CallerIdentity | null> => {
    if (!warned) {
      console.warn(
        "appa/devAuth: trusting client-supplied asUserId — DO NOT use this resolver " +
          "in any environment where the server can be reached by an untrusted client.",
      );
      warned = true;
    }
    const teamReader = (req.app.locals as { team?: TeamReader }).team;
    if (!teamReader) return null;
    const headerVal = req.get?.("x-appa-user") ?? "";
    const body = (req.body ?? {}) as { asUserId?: unknown };
    const queryVal = req.query?.asUserId;
    const id =
      typeof body.asUserId === "string" && body.asUserId
        ? body.asUserId
        : typeof headerVal === "string" && headerVal
          ? headerVal
          : typeof queryVal === "string"
            ? queryVal
            : "";
    if (!id) return null;
    const member = await teamReader.findById(id);
    if (!member) return null;
    return { id: member.id, isCoach: member.role === "coach" };
  };
}

// Re-export the thread ownership helper from where it lives. Kept here
// for backwards-compat with anything that imported it from server/auth.
export { callerOwnsThread };
