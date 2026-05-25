// Appa project config. Edit this to add modules or change defaults.
//
// To add a custom module, drop a file under ./modules/ that exports an AppaModule
// (see https://github.com/karl-kahn/appa#modules), import it, and add it to the
// `modules` array below.

import { defineConfig } from "appa";
import tasks from "appa/modules/tasks";
import photos from "appa/modules/photos";
import activity from "appa/modules/activity";

export default defineConfig({
  port: 3848,
  host: "127.0.0.1",
  model: "sonnet",
  modules: [tasks, photos, activity],
});
