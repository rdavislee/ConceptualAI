import { exists } from "jsr:@std/fs/exists";
import * as path from "jsr:@std/path";

const CONFIG_DIR = ".conceptual";
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export interface Config {
  accessToken?: string;
  refreshToken?: string;
  apiUrl?: string;
}

/**
 * Get the API base URL from environment variable or default
 */
export function getApiUrl(): string {
  const envUrl = Deno.env.get("CONCEPTUAL_API_URL");
  if (envUrl) {
    return envUrl;
  }
  // Default to localhost:8000
  return "https://concepthub-backend.onrender.com";
  // return "http://localhost:8000";
}

/**
 * Load configuration from file
 */
export async function loadConfig(): Promise<Config> {
  try {
    if (await exists(CONFIG_FILE)) {
      const content = await Deno.readTextFile(CONFIG_FILE);
      return JSON.parse(content) as Config;
    }
  } catch (_error) {
    // Config file doesn't exist or is invalid, return empty config
  }
  return {};
}

/**
 * Save configuration to file
 */
export async function saveConfig(config: Config): Promise<void> {
  // Ensure config directory exists
  if (!(await exists(CONFIG_DIR))) {
    await Deno.mkdir(CONFIG_DIR, { recursive: true });
  }

  await Deno.writeTextFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Get stored access token
 */
export async function getAccessToken(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.accessToken;
}

/**
 * Get stored refresh token
 */
export async function getRefreshToken(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.refreshToken;
}

/**
 * Save access and refresh tokens to config
 */
export async function saveTokens(
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  const config = await loadConfig();
  config.accessToken = accessToken;
  config.refreshToken = refreshToken;
  await saveConfig(config);
}

/**
 * Clear stored tokens (for logout)
 */
export async function clearTokens(): Promise<void> {
  const config = await loadConfig();
  config.accessToken = undefined;
  config.refreshToken = undefined;
  await saveConfig(config);
}
