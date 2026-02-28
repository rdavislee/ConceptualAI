/**
 * API Client - Auto-generated base for connecting to the backend
 * 
 * Configuration:
 * - Set VITE_API_URL in .env to point to your backend
 * - Default: http://localhost:8000/api
 */

/**
 * Custom error class that preserves HTTP status codes.
 * Use error.status in catch blocks to differentiate 401 vs 404 vs other errors.
 *
 * @example
 * try { await api.get('/me/profile'); }
 * catch (e) {
 *   if (e instanceof ApiError && e.status === 401) clearAuthToken();
 *   if (e instanceof ApiError && e.status === 404) navigate('/onboarding');
 * }
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8000/api";

/** Base URL without the /api suffix, for non-API routes like media serving */
const SERVER_BASE_URL = API_BASE_URL.replace(/\/api\/?$/, "");
const API_BASE_URL_NORMALIZED = API_BASE_URL.replace(/\/+$/, "");

/**
 * Resolve a backend media path (e.g. /media/abc123) to a full URL.
 * Use this for ALL <img src>, <video src>, avatar URLs, etc.
 * that reference backend-served files.
 *
 * @example <img src={getMediaUrl(post.imageUrl)} />
 */
export function getMediaUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // Accept either /media/{id} or /api/media/{id} from backend payloads.
  if (normalizedPath.startsWith("/api/media/")) {
    return `${SERVER_BASE_URL}${normalizedPath}`;
  }
  if (normalizedPath.startsWith("/media/")) {
    return `${API_BASE_URL_NORMALIZED}${normalizedPath}`;
  }

  // Fallback: treat unknown relative paths as API-relative resources.
  if (normalizedPath.startsWith("/api/")) {
    return `${SERVER_BASE_URL}${normalizedPath}`;
  }
  return `${API_BASE_URL_NORMALIZED}${normalizedPath}`;
}

/**
 * Upload a file via multipart/form-data.
 * Do NOT set Content-Type manually — the browser sets it with the boundary.
 *
 * @example const { url } = await uploadFile("/media", file);
 */
export async function uploadFile<T = any>(
  endpoint: string,
  file: File,
  fieldName = "file"
): Promise<T> {
  const token = getAuthToken();
  const form = new FormData();
  form.append(fieldName, file);

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE_URL}${endpoint}`, {
    method: "POST",
    headers,
    body: form,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new ApiError(error.message || `API Error: ${response.status}`, response.status);
  }

  const text = await response.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

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
    throw new ApiError(error.message || `API Error: ${response.status}`, response.status);
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
