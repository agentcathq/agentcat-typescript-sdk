/// <reference types="@cloudflare/workers-types" />

import { waitUntil } from "cloudflare:workers";
import { setBackgroundTaskRegistrar } from "./modules/backgroundTasks.js";

setBackgroundTaskRegistrar((task) => waitUntil(task));

export * from "./index.js";
