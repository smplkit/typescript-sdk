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
  "  3. Create a ~/.smplkit file with:\n" +
  "     [default]\n" +
  "     api_key = your_key_here";

export function resolveApiKey(explicit?: string): string {
  if (explicit) return explicit;

  const envVal = process.env.SMPLKIT_API_KEY;
  if (envVal) return envVal;

  const configPath = join(homedir(), ".smplkit");
  try {
    const content = readFileSync(configPath, "utf-8");
    let inDefaultSection = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[")) {
        inDefaultSection = trimmed.toLowerCase() === "[default]";
        continue;
      }
      if (inDefaultSection && trimmed.startsWith("api_key")) {
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex !== -1) {
          const value = trimmed.slice(eqIndex + 1).trim();
          if (value) return value;
        }
      }
    }
  } catch {
    // File doesn't exist or isn't readable — skip
  }

  throw new SmplError(NO_API_KEY_MESSAGE);
}
