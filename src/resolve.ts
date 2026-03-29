/**
 * API key resolution chain: explicit → env var → config file.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SmplError } from "./errors.js";

const NO_API_KEY_MESSAGE =
  "No API key provided. Set one of:\n" +
  "  1. Pass apiKey to the constructor\n" +
  "  2. Set the SMPLKIT_API_KEY environment variable\n" +
  "  3. Add api_key to [default] in ~/.smplkit";

export function resolveApiKey(explicit?: string): string {
  if (explicit) return explicit;

  const envVal = process.env.SMPLKIT_API_KEY;
  if (envVal) return envVal;

  const configPath = join(homedir(), ".smplkit");
  try {
    const content = readFileSync(configPath, "utf-8");
    const match = content.match(
      /\[default\]\s*[\s\S]*?api_key\s*=\s*"([^"]+)"/,
    );
    if (match?.[1]) return match[1];
  } catch {
    // File doesn't exist or isn't readable — skip
  }

  throw new SmplError(NO_API_KEY_MESSAGE);
}
