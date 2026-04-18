/**
 * Configuration profile resolver — internal module.
 *
 * Implements 4-step resolution: defaults → file ([common] + profile) → env vars → constructor args.
 * Not re-exported from the public SDK surface.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SmplError } from "./errors.js";

/** Config keys mapped to their environment variable names. */
const CONFIG_KEYS = {
  api_key: "SMPLKIT_API_KEY",
  base_domain: "SMPLKIT_BASE_DOMAIN",
  scheme: "SMPLKIT_SCHEME",
  environment: "SMPLKIT_ENVIRONMENT",
  service: "SMPLKIT_SERVICE",
  debug: "SMPLKIT_DEBUG",
  disable_telemetry: "SMPLKIT_DISABLE_TELEMETRY",
} as const;

/** Fully resolved configuration after the 4-step merge. */
export interface ResolvedConfig {
  apiKey: string;
  baseDomain: string;
  scheme: string;
  environment: string;
  service: string;
  debug: boolean;
  disableTelemetry: boolean;
}

/**
 * Parse an INI-style config file, merging [common] with the selected profile.
 *
 * Returns a flat key-value map where the profile section overlays [common].
 * Supports `#` and `;` line comments and trims whitespace around keys/values.
 */
export function parseIniFile(content: string, profile: string): Record<string, string> {
  const common: Record<string, string> = {};
  const profileValues: Record<string, string> = {};
  const sections = new Set<string>();

  let currentSection: string | null = null;
  const lowerProfile = profile.toLowerCase();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    if (trimmed.startsWith("[")) {
      const closeBracket = trimmed.indexOf("]");
      if (closeBracket === -1) continue;
      currentSection = trimmed.slice(1, closeBracket).trim().toLowerCase();
      if (currentSection !== "common") {
        sections.add(currentSection);
      }
      continue;
    }

    if (currentSection === null) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!key || !value) continue;

    if (currentSection === "common") {
      common[key] = value;
    } else if (currentSection === lowerProfile) {
      profileValues[key] = value;
    }
  }

  // Error if the profile was explicitly named (not "default"), the file has
  // non-common sections, and none of them match the requested profile.
  if (
    lowerProfile !== "default" &&
    sections.size > 0 &&
    !sections.has(lowerProfile) &&
    Object.keys(profileValues).length === 0
  ) {
    const available = [...sections].sort().join(", ");
    throw new SmplError(
      `Configuration profile "${profile}" not found in ~/.smplkit. ` +
        `Available profiles: ${available}`,
    );
  }

  return { ...common, ...profileValues };
}

/**
 * Parse a boolean string value.
 *
 * Accepts true/1/yes and false/0/no (case-insensitive).
 * Throws SmplError for unrecognised values.
 */
export function parseBool(value: string, key: string): boolean {
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") return true;
  if (lower === "false" || lower === "0" || lower === "no") return false;
  throw new SmplError(
    `Invalid boolean value "${value}" for ${key}. Expected true/false, 1/0, or yes/no.`,
  );
}

/** Build a service URL from scheme, subdomain, and base domain. */
export function serviceUrl(scheme: string, subdomain: string, baseDomain: string): string {
  return `${scheme}://${subdomain}.${baseDomain}`;
}

/** Options accepted by the SmplClient constructor (imported from client.ts at the type level). */
interface ConstructorOptions {
  apiKey?: string;
  environment?: string;
  service?: string;
  timeout?: number;
  disableTelemetry?: boolean;
  profile?: string;
  baseDomain?: string;
  scheme?: string;
  debug?: boolean;
}

const NO_API_KEY_MESSAGE =
  "No API key provided. Set one of:\n" +
  "  1. Pass apiKey to the constructor\n" +
  "  2. Set the SMPLKIT_API_KEY environment variable\n" +
  "  3. Add api_key to your ~/.smplkit config file";

const NO_ENVIRONMENT_MESSAGE =
  "No environment provided. Set one of:\n" +
  "  1. Pass environment to the constructor\n" +
  "  2. Set the SMPLKIT_ENVIRONMENT environment variable\n" +
  "  3. Add environment to your ~/.smplkit config file";

const NO_SERVICE_MESSAGE =
  "No service provided. Set one of:\n" +
  "  1. Pass service in options\n" +
  "  2. Set the SMPLKIT_SERVICE environment variable\n" +
  "  3. Add service to your ~/.smplkit config file";

/**
 * Resolve configuration using the 4-step algorithm:
 * 1. Defaults
 * 2. Config file ([common] + profile)
 * 3. Environment variables
 * 4. Constructor arguments
 */
export function resolveConfig(options: ConstructorOptions): ResolvedConfig {
  // --- Step 1: Defaults ---
  const merged: Record<string, string | undefined> = {
    scheme: "https",
    base_domain: "smplkit.com",
    debug: "false",
    disable_telemetry: "false",
  };

  // --- Step 2: Config file ---
  const profile = options.profile ?? process.env.SMPLKIT_PROFILE ?? "default";
  try {
    const configPath = join(homedir(), ".smplkit");
    const content = readFileSync(configPath, "utf-8");
    const fileValues = parseIniFile(content, profile);
    for (const key of Object.keys(CONFIG_KEYS)) {
      if (fileValues[key]) {
        merged[key] = fileValues[key];
      }
    }
  } catch (e) {
    // Re-throw SmplError (e.g. missing profile)
    if (e instanceof SmplError) throw e;
    // File doesn't exist or isn't readable — skip
  }

  // --- Step 3: Environment variables ---
  for (const [key, envVar] of Object.entries(CONFIG_KEYS)) {
    const envVal = process.env[envVar];
    if (envVal) {
      merged[key] = envVal;
    }
  }

  // --- Step 4: Constructor arguments ---
  if (options.apiKey !== undefined) merged.api_key = options.apiKey;
  if (options.baseDomain !== undefined) merged.base_domain = options.baseDomain;
  if (options.scheme !== undefined) merged.scheme = options.scheme;
  if (options.environment !== undefined) merged.environment = options.environment;
  if (options.service !== undefined) merged.service = options.service;
  if (options.debug !== undefined) merged.debug = String(options.debug);
  if (options.disableTelemetry !== undefined) merged.disable_telemetry = String(options.disableTelemetry);

  // --- Step 5: Validate required fields ---
  if (!merged.api_key) throw new SmplError(NO_API_KEY_MESSAGE);
  if (!merged.environment) throw new SmplError(NO_ENVIRONMENT_MESSAGE);
  if (!merged.service) throw new SmplError(NO_SERVICE_MESSAGE);

  return {
    apiKey: merged.api_key,
    baseDomain: merged.base_domain!,
    scheme: merged.scheme!,
    environment: merged.environment,
    service: merged.service,
    debug: parseBool(merged.debug!, "debug"),
    disableTelemetry: parseBool(merged.disable_telemetry!, "disable_telemetry"),
  };
}
