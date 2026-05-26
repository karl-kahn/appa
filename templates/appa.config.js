// Appa project config.
//
// This is an ES module (the package.json sets "type": "module"). Use
// `import`, not `require`. If you adapt code from a CommonJS tutorial,
// you'll need to convert it to ESM or the kernel won't start.
//
// To add a custom module, drop a file under ./modules/ that exports an
// AppaModule (see https://github.com/karl-kahn/appa#modules), import it,
// and add it to the `modules` array below.

import { defineConfig, devAuth } from "appa";
import activity from "appa/modules/activity";
import photos from "appa/modules/photos";
import tasks from "appa/modules/tasks";

export default defineConfig({
  port: 3848,
  host: "127.0.0.1",

  // Claude model alias. "sonnet" is the balance pick (~$3/M input,
  // $15/M output). "haiku" is roughly 1/3 the cost — switch to it for
  // a high-volume classroom where ten dollars per session is steep.
  // The aliases ARE floating — when Anthropic rotates the underlying
  // model behind "sonnet", every deployment silently upgrades. Pin a
  // version if that matters to your context.
  model: "sonnet",

  modules: [tasks, photos, activity],

  // ⚠️ AUTH — read before exposing this server anywhere.
  //
  // appa ships no built-in authentication. The kernel rejects every
  // request unless you supply a `resolveCaller` that maps a request to
  // a team member.
  //
  // devAuth() (used below) is the dev-mode convenience: it trusts a
  // client-supplied `asUserId` POST body field / X-Appa-User header /
  // ?asUserId= query param and looks the id up in team.json. It is
  // intentionally NOT SAFE for any deployment — anyone who can reach
  // the URL can act as any user (including the coach).
  //
  // For production, REPLACE devAuth() with a resolver that reads
  // identity from a trusted source — a reverse-proxy header set by
  // your SSO, a signed session cookie, mTLS client cert, Tailscale
  // device tag, etc. Example skeleton:
  //
  //   resolveCaller: async (req) => {
  //     const userIdFromProxy = req.get("X-Trusted-User"); // set by your SSO/proxy
  //     if (!userIdFromProxy) return null;
  //     const teamReader = req.app.locals.team;
  //     const member = await teamReader.findById(userIdFromProxy);
  //     return member ? { id: member.id, isCoach: member.role === "coach" } : null;
  //   },
  resolveCaller: devAuth(),
});
