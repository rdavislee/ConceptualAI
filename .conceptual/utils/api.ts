import {
  getAccessToken,
  getApiUrl,
  getRefreshToken,
  saveTokens,
} from "./config.ts";

export interface ApiError {
  error: string;
}

interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
}

/**
 * Refresh access token using refresh token
 */
async function refreshAccessToken(): Promise<string | undefined> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) {
    return undefined;
  }

  try {
    const apiUrl = getApiUrl();
    const url = `${apiUrl}/api/auth/refresh`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) {
      // Refresh token is invalid or expired
      return undefined;
    }

    const data = await response.json() as RefreshTokenResponse;
    await saveTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    // Failed to refresh token
    return undefined;
  }
}

/**
 * Make a POST request to the API
 * Automatically refreshes token if it expires
 */
export async function apiRequest<T>(
  endpoint: string,
  body: unknown,
  options: { requireAuth?: boolean; timeout?: number } = {},
): Promise<T> {
  const apiUrl = getApiUrl();
  const url = `${apiUrl}${endpoint}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Get access token if available
  let accessToken: string | undefined;
  if (options.requireAuth !== false) {
    accessToken = await getAccessToken();
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }
  }

  // Include accessToken in request body (as expected by Requesting concept)
  const requestBody =
    typeof body === "object" && body !== null && !Array.isArray(body)
      ? {
        ...body as Record<string, unknown>,
        ...(accessToken && { accessToken }),
      }
      : body;

  // Create AbortController for timeout
  const timeout = options.timeout || 60000; // Default 60 seconds
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    let response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // If access token expired, try to refresh and retry
    if (
      response.status === 401 &&
      options.requireAuth !== false &&
      accessToken
    ) {
      const errorData = await response.json().catch(() => ({})) as ApiError;
      if (
        errorData.error === "Access token expired" ||
        errorData.error?.includes("expired")
      ) {
        // Try to refresh the token
        const newAccessToken = await refreshAccessToken();
        if (newAccessToken) {
          // Retry the request with new token
          headers["Authorization"] = `Bearer ${newAccessToken}`;
          const retryRequestBody =
            typeof body === "object" && body !== null && !Array.isArray(body)
              ? {
                ...body as Record<string, unknown>,
                accessToken: newAccessToken,
              }
              : body;

          // Create new controller for retry
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(
            () => retryController.abort(),
            timeout,
          );

          try {
            response = await fetch(url, {
              method: "POST",
              headers,
              body: JSON.stringify(retryRequestBody),
              signal: retryController.signal,
            });
            clearTimeout(retryTimeoutId);
          } catch (retryError) {
            clearTimeout(retryTimeoutId);
            if (
              retryError instanceof Error &&
              retryError.name === "AbortError"
            ) {
              throw new Error(`Request timed out after ${timeout}ms`);
            }
            throw retryError;
          }
        }
      }
    }

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}: ${response.statusText}`;
      try {
        const errorData = await response.json() as ApiError;
        if (errorData.error) {
          errorMessage = errorData.error;
        }
      } catch {
        // If response is not JSON, use the status text
      }
      throw new Error(errorMessage);
    }

    return await response.json() as T;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  }
}
