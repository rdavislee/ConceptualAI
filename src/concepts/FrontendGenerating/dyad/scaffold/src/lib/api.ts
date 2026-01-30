/**
 * API Client - Auto-generated base for connecting to the backend
 * 
 * Configuration:
 * - Set VITE_API_URL in .env to point to your backend
 * - Default: http://localhost:8000/api
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000/api";

/**
 * Get the stored auth token
 */
export function getAuthToken(): string | null {
  return localStorage.getItem("authToken");
}

/**
 * Set the auth token (call after login)
 */
export function setAuthToken(token: string): void {
  localStorage.setItem("authToken", token);
}

/**
 * Clear the auth token (call on logout)
 */
export function clearAuthToken(): void {
  localStorage.removeItem("authToken");
}

/**
 * Make an authenticated API request
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getAuthToken();
  
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  
  if (token) {
    (headers as Record<string, string>)["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `API Error: ${response.status}`);
  }

  // Handle empty responses
  const text = await response.text();
  if (!text) return {} as T;
  
  return JSON.parse(text) as T;
}

/**
 * Convenience methods for common HTTP verbs
 */
export const api = {
  get: <T>(endpoint: string) => apiRequest<T>(endpoint, { method: "GET" }),
  
  post: <T>(endpoint: string, data?: unknown) => 
    apiRequest<T>(endpoint, { 
      method: "POST", 
      body: data ? JSON.stringify(data) : undefined 
    }),
  
  put: <T>(endpoint: string, data?: unknown) => 
    apiRequest<T>(endpoint, { 
      method: "PUT", 
      body: data ? JSON.stringify(data) : undefined 
    }),
  
  patch: <T>(endpoint: string, data?: unknown) => 
    apiRequest<T>(endpoint, { 
      method: "PATCH", 
      body: data ? JSON.stringify(data) : undefined 
    }),
  
  delete: <T>(endpoint: string) => apiRequest<T>(endpoint, { method: "DELETE" }),
};

export { API_BASE_URL };

