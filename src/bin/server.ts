#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { runConfiguredServer } from "#/http/server-runner";

BunRuntime.runMain(runConfiguredServer);
