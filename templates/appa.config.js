// Appa project config. Edit this to add modules or change defaults.
//
// To add a custom module, drop a file under ./modules/ that exports an AppaModule
// (see https://github.com/karl-kahn/appa#modules), import it, and add it to the
// `modules` array below.

import { defineConfig, devAuth } from "appa";
import activity from "appa/modules/activity";
import photos from "appa/modules/photos";
import tasks from "appa/modules/tasks";

export default defineConfig({
  port: 3848,
  host: "127.0.0.1",
  model: "sonnet",
  modules: [tasks, photos, activity],

  // ⚠️ AUTH — read before deploying anywhere reachable by an untrusted client.
  //
  // appa ships no built-in authentication. The kernel rejects every request
  // unless you supply a `resolveCaller` that maps a request to a team
  // member.
  //
  // devAuth() (used below) is the dev-mode convenience: it trusts a
  // client-supplied `asUserId` POST body field and looks it up in team.json.
  // It is intentionally NOT SAFE for any deployment — anyone who can reach
  // the URL can act as any user (including the coach).
  //
  // For production, replace devAuth() with a resolver that reads identity
  // from a trusted source (signed cookie, reverse-proxy header from your
  // SSO, mTLS client cert, Tailscale device tag, etc.).
  resolveCaller: devAuth(),
});
