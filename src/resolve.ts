/**
 * API key resolution chain: explicit → env var → config file.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SmplError } from "./errors.js";

function noApiKeyMessage(environment: string): string {
  return (
    "No API key provided. Set one of:\n" +
    "  1. Pass apiKey to the constructor\n" +
    "  2. Set the SMPLKIT_API_KEY environment variable\n" +
    "  3. Create a ~/.smplkit file with:\n" +
    `     [${environment}]\n` +
    "     api_key = your_key_here"
  );
}

/**
 * Parse the ~/.smplkit INI file and return the api_key value.
 * Tries the `[{environment}]` section first, then falls back to `[default]`.
 */
function readApiKeyFromConfig(environment: string): string | undefined {
  const configPath = join(homedir(), ".smplkit");
  try {
    const content = readFileSync(configPath, "utf-8");
    let currentSection: string | null = null;
    let envKey: string | undefined;
    let defaultKey: string | undefined;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[")) {
        const sectionName = trimmed.slice(1, trimmed.indexOf("]")).toLowerCase();
        currentSection = sectionName;
        continue;
      }
      if (currentSection && trimmed.startsWith("api_key")) {
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex !== -1) {
          const value = trimmed.slice(eqIndex + 1).trim();
          if (value) {
            if (currentSection === environment.toLowerCase()) {
              envKey = value;
            } else if (currentSection === "default") {
              defaultKey = value;
            }
          }
        }
      }
    }

    return envKey ?? defaultKey;
  } catch {
    // File doesn't exist or isn't readable — skip
    return undefined;
  }
}

export function resolveApiKey(explicit: string | undefined, environment: string): string {
  if (explicit) return explicit;

  const envVal = process.env.SMPLKIT_API_KEY;
  if (envVal) return envVal;

  const fileKey = readApiKeyFromConfig(environment);
  if (fileKey) return fileKey;

  throw new SmplError(noApiKeyMessage(environment));
}
