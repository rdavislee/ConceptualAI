import fs from "fs-extra";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText, generateObject } from "ai";
import { z } from "zod";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config();

const execAsync = promisify(exec);

// Inline the system prompt from dyad (simplified) since we can't import easily
const BUILD_SYSTEM_PROMPT = `
<role> You are Dyad, an AI editor that creates and modifies web applications. </role>

# Guidelines
- Only edit files that are related to the user's request.
- Use <dyad-write> for creating or updating files.
- Use <dyad-rename> for renaming files.
- Use <dyad-delete> for removing files.
- Use <dyad-add-dependency> for installing packages.

# Examples

<dyad-write path="src/components/Button.tsx" description="Creating a new Button component">
"use client";
import React from 'react';
const Button = ({ children }) => <button>{children}</button>;
export default Button;
</dyad-write>

# REMEMBER
> **CODE FORMATTING IS NON-NEGOTIABLE:**
> **NEVER** use markdown code blocks (\`\`\`) for code.
> **ONLY** use <dyad-write> tags for **ALL** code output.
`;

// Helper to extract tags (re-implemented to avoid complex imports if needed, but we try to import)
// We will try to rely on the prompt being obeyed.
function parseTags(response: string) {
    const dyadWriteRegex = /<dyad-write([^>]*)>([\s\S]*?)<\/dyad-write>/gi;
    const pathRegex = /path="([^"]+)"/;

    const updates: { path: string; content: string }[] = [];
    let match;

    while ((match = dyadWriteRegex.exec(response)) !== null) {
        const attrs = match[1];
        const content = match[2].trim();
        const pathMatch = pathRegex.exec(attrs);
        if (pathMatch) {
            updates.push({ path: pathMatch[1], content });
        }
    }
    return updates;
}

// ============================================================
// REVIEW/FIX LOOP — Post-generation build verification and
// per-node semantic review, driven by the App Graph.
// ============================================================

const MAX_NODE_FIX_ATTEMPTS = 5;  // Per-node: fix → re-review cycles
// Worker limits are calibrated against Gemini 2.5 Pro rate limits (the bottleneck model):
//   Tier 1: 150 RPM  → 5 workers × ~4s avg latency ≈ 75 RPM (50% headroom)
//   Tier 2: 1,000 RPM → 20 workers × ~4s avg latency ≈ 300 RPM
//   Tier 3: 1,500 RPM → 30 workers × ~4s avg latency ≈ 450 RPM
const TIER_WORKER_LIMITS: Record<string, number> = {
    "0": 0,
    "1": 5,
    "2": 20,
    "3": 30,
};

function resolveParallelWorkersFromTier(rawTier?: string): { tier: string; maxWorkers: number } {
    const tier = (rawTier || "1").trim();
    if (tier in TIER_WORKER_LIMITS) {
        return { tier, maxWorkers: TIER_WORKER_LIMITS[tier] };
    }
    console.warn(`[Concurrency] Unsupported GEMINI_TIER "${tier}". Defaulting to tier 1 (5 workers).`);
    return { tier: "1", maxWorkers: TIER_WORKER_LIMITS["1"] };
}

// --- Types ---

interface BuildCheckResult {
    success: boolean;
    errors: string;
    errorFiles: string[];
}

interface ReviewIssue {
    severity: "critical" | "warning";
    file: string;
    edgeRef?: string;
    description: string;
    expected: string;
    actual: string;
}

interface NodeReview {
    nodeId: string;
    issues: ReviewIssue[];
    verdict: "pass" | "fail";
}

interface RouteMapEntry {
    nodeId: string;
    nodePath: string;
    componentName: string;
    filePath: string;
}

interface RouteMapResult {
    mappings: RouteMapEntry[];
    unmappedNodes: string[];
    warnings: string[];
}

interface ReviewResults {
    iterations: number;
    finalVerdict: "pass" | "fail";
    nodeReviews: NodeReview[];
    buildErrorHistory: Array<{ iteration: number; errors: string; source: string }>;
    fixerHistory: Array<{ iteration: number; filesModified: string[] }>;
    finalBuildErrors?: string;
}

interface NodeEndpointRef {
    method: string;
    path: string;
    sources: string[];
}

interface NodeEndpointContext {
    refs: NodeEndpointRef[];
    refsText: string;
    openApiSnippetsText: string;
}

// --- Zod schema for per-node reviewer output ---

const nodeReviewSchema = z.object({
    nodeId: z.string(),
    issues: z.array(z.object({
        severity: z.enum(["critical", "warning"]),
        file: z.string(),
        edgeRef: z.string().optional(),
        description: z.string(),
        expected: z.string(),
        actual: z.string(),
    })),
    verdict: z.enum(["pass", "fail"]),
});

// --- Helpers ---

async function parallelLimit<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results: T[] = new Array(tasks.length);
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < tasks.length) {
            const i = nextIndex++;
            results[i] = await tasks[i]();
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return results;
}

function createAsyncMutex() {
    let current = Promise.resolve();
    return async function withLock<T>(fn: () => Promise<T>): Promise<T> {
        const next = current.then(fn, fn);
        current = next.then(() => undefined, () => undefined);
        return next;
    };
}

function normalizeAppGraphPath(p: string): string {
    return p.replace(/\{(\w+)\}/g, ":$1");
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);

function extractHttpEndpointRef(value: unknown): { method: string; path: string } | null {
    if (typeof value !== "string") return null;
    const m = value.match(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+([/][^\s,;"'`]+)/i);
    if (!m) return null;
    const method = m[1].toUpperCase();
    const pathValue = m[2].trim().replace(/[),.;]+$/g, "");
    if (!pathValue.startsWith("/")) return null;
    return { method, path: pathValue };
}

function addNodeEndpointRef(
    refsByKey: Map<string, NodeEndpointRef>,
    rawValue: unknown,
    sourceLabel: string,
) {
    const parsed = extractHttpEndpointRef(rawValue);
    if (!parsed) return;
    const key = `${parsed.method} ${parsed.path}`;
    const existing = refsByKey.get(key);
    if (existing) {
        if (!existing.sources.includes(sourceLabel)) existing.sources.push(sourceLabel);
        return;
    }
    refsByKey.set(key, { method: parsed.method, path: parsed.path, sources: [sourceLabel] });
}

function collectNodeEndpointRefs(
    node: { data_requirements?: unknown[] } | null | undefined,
    edges: Array<Record<string, unknown>>,
): NodeEndpointRef[] {
    const refsByKey = new Map<string, NodeEndpointRef>();
    const dataRequirements = Array.isArray(node?.data_requirements) ? node.data_requirements : [];
    for (let i = 0; i < dataRequirements.length; i++) {
        addNodeEndpointRef(refsByKey, dataRequirements[i], `data_requirements[${i}]`);
    }

    for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        const trigger = typeof edge?.trigger === "string" ? edge.trigger : `edge[${i}]`;
        addNodeEndpointRef(refsByKey, edge?.action, `edge action "${trigger}"`);
        const onSuccess = (typeof edge?.on_success === "object" && edge.on_success !== null)
            ? edge.on_success as Record<string, unknown>
            : undefined;
        const onError = (typeof edge?.on_error === "object" && edge.on_error !== null)
            ? edge.on_error as Record<string, unknown>
            : undefined;
        addNodeEndpointRef(refsByKey, onSuccess?.action, `on_success action "${trigger}"`);
        addNodeEndpointRef(refsByKey, onError?.action, `on_error action "${trigger}"`);
    }

    return [...refsByKey.values()].sort((a, b) => {
        const pathCmp = a.path.localeCompare(b.path);
        if (pathCmp !== 0) return pathCmp;
        return a.method.localeCompare(b.method);
    });
}

function extractOpenApiPathBlocks(openapiContent: string): Map<string, string[]> {
    const blocks = new Map<string, string[]>();
    if (!openapiContent.trim()) return blocks;
    const lines = openapiContent.replace(/\r\n/g, "\n").split("\n");
    const pathsStart = lines.findIndex((line) => line.trim() === "paths:");
    if (pathsStart === -1) return blocks;

    let i = pathsStart + 1;
    while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
            i++;
            continue;
        }
        if (!line.startsWith(" ")) break; // left "paths:" section

        const pathMatch = line.match(/^\s{2}["']?(\/[^"']*)["']?:\s*$/);
        if (!pathMatch) {
            i++;
            continue;
        }

        const pathKey = pathMatch[1].trim();
        let j = i + 1;
        while (j < lines.length) {
            const next = lines[j];
            if (!next.trim()) {
                j++;
                continue;
            }
            if (!next.startsWith(" ")) break;
            if (/^\s{2}["']?(\/[^"']*)["']?:\s*$/.test(next)) break;
            j++;
        }

        blocks.set(pathKey, lines.slice(i, j));
        i = j;
    }

    return blocks;
}

function extractOpenApiOperationSnippet(pathBlock: string[], method: string): string | null {
    const methodName = method.toLowerCase();
    let methodStart = -1;
    for (let i = 1; i < pathBlock.length; i++) {
        const m = pathBlock[i].match(/^\s{4}([A-Za-z]+):\s*$/);
        if (m && m[1].toLowerCase() === methodName) {
            methodStart = i;
            break;
        }
    }
    if (methodStart === -1) return null;

    let methodEnd = pathBlock.length;
    for (let i = methodStart + 1; i < pathBlock.length; i++) {
        const m = pathBlock[i].match(/^\s{4}([A-Za-z]+):\s*$/);
        if (m && HTTP_METHODS.has(m[1].toLowerCase())) {
            methodEnd = i;
            break;
        }
    }
    return [pathBlock[0], ...pathBlock.slice(methodStart, methodEnd)].join("\n").trim();
}

function buildNodeEndpointContext(
    node: { data_requirements?: unknown[] } | null | undefined,
    edges: Array<Record<string, unknown>>,
    openapiContent: string,
): NodeEndpointContext {
    const refs = collectNodeEndpointRefs(node, edges);
    const refsText = refs.length > 0
        ? refs.map((ref) => `- ${ref.method} ${ref.path} (from: ${ref.sources.join(", ")})`).join("\n")
        : "- (No explicit HTTP endpoint signatures found in this node's data_requirements or edge actions.)";

    if (refs.length === 0) {
        return { refs, refsText, openApiSnippetsText: "(No precomputed OpenAPI operation snippets available.)" };
    }

    const pathBlocks = extractOpenApiPathBlocks(openapiContent);
    const snippets: string[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
        const pathBlock = pathBlocks.get(ref.path);
        const opSnippet = pathBlock ? extractOpenApiOperationSnippet(pathBlock, ref.method) : null;
        if (opSnippet) snippets.push(`# ${ref.method} ${ref.path}\n${opSnippet}`);
        else missing.push(`${ref.method} ${ref.path}`);
    }

    let openApiSnippetsText = snippets.length > 0
        ? snippets.join("\n\n")
        : "(No matching OpenAPI operations found for the precomputed endpoint targets.)";
    if (missing.length > 0) {
        openApiSnippetsText += `\n\n# Missing operation matches\n${missing.map((m) => `- ${m}`).join("\n")}`;
    }

    return { refs, refsText, openApiSnippetsText };
}

function readSharedFiles(outDir: string, extraPaths: string[] = []): Record<string, string> {
    const shared: Record<string, string> = {};
    const tryRead = (label: string, relPath: string) => {
        const full = path.join(outDir, relPath);
        if (fs.existsSync(full)) {
            shared[label] = fs.readFileSync(full, "utf-8");
            return true;
        }
        return false;
    };
    tryRead("src/App.tsx", "src/App.tsx");
    tryRead("src/lib/api.ts", "src/lib/api.ts");
    tryRead("src/lib/types.ts", "src/lib/types.ts");
    // AuthContext — search common locations
    const authPaths = [
        "src/contexts/AuthContext.tsx", "src/context/AuthContext.tsx",
        "src/providers/AuthProvider.tsx", "src/contexts/AuthProvider.tsx",
    ];
    for (const p of authPaths) { if (tryRead(p, p)) break; }
    for (const relPath of extraPaths) {
        tryRead(relPath, relPath);
    }
    return shared;
}

function normalizeForMatch(input: string): string {
    return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function replaceOnceWithNormalization(
    original: string,
    search: string,
    replacement: string,
): { updated: string; mode: "exact" | "normalized" | null } {
    if (!search) return { updated: original, mode: null };

    if (original.includes(search)) {
        return { updated: original.replace(search, replacement), mode: "exact" };
    }

    // Docker/Linux execution can surface LF while checked out files may be CRLF.
    // Fall back to normalized matching, but only when the match is unique.
    const normalizedOriginal = normalizeForMatch(original);
    const normalizedSearch = normalizeForMatch(search);
    if (!normalizedSearch.trim()) return { updated: original, mode: null };

    const firstIndex = normalizedOriginal.indexOf(normalizedSearch);
    if (firstIndex === -1) return { updated: original, mode: null };
    const secondIndex = normalizedOriginal.indexOf(normalizedSearch, firstIndex + normalizedSearch.length);
    if (secondIndex !== -1) return { updated: original, mode: null };

    const updated =
        normalizedOriginal.slice(0, firstIndex) +
        replacement +
        normalizedOriginal.slice(firstIndex + normalizedSearch.length);
    return { updated, mode: "normalized" };
}

// --- Sync dependencies from source (catches react-hot-toast, etc. from fix loops + missing pages) ---

function collectThirdPartyImports(content: string): Set<string> {
    const out = new Set<string>();
    const re = /(?:from\s+['"]|require\s*\(\s*['"])([^./'"@][^'"]*|@[^/'"]+\/[^'"]+)['"]/g;
    let im;
    while ((im = re.exec(content)) !== null) {
        const spec = im[1];
        const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        out.add(pkgName);
    }
    return out;
}

function syncDependenciesFromSource(outDir: string): boolean {
    const srcDir = path.join(outDir, "src");
    if (!fs.existsSync(srcDir)) return false;
    const thirdPartyImports = new Set<string>();
    const walk = (dir: string) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.(ts|tsx|js|jsx)$/.test(e.name)) {
                const content = fs.readFileSync(full, "utf-8");
                for (const p of collectThirdPartyImports(content)) thirdPartyImports.add(p);
            }
        }
    };
    walk(srcDir);
    if (thirdPartyImports.size === 0) return false;
    const pkgPath = path.join(outDir, "package.json");
    if (!fs.existsSync(pkgPath)) return false;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const missing = [...thirdPartyImports].filter(p => !allDeps[p]);
    if (missing.length === 0) return false;
    pkg.dependencies = pkg.dependencies || {};
    for (const dep of missing) {
        pkg.dependencies[dep] = "latest";
        console.log(`[Deps] Added missing dependency "${dep}" to package.json (from source scan)`);
    }
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
    return true;
}

// --- Step 2: Build Check ---

async function runBuildCheck(outDir: string, needsInstall: boolean): Promise<BuildCheckResult> {
    try {
        const depsChanged = syncDependenciesFromSource(outDir);
        if (depsChanged || needsInstall) {
            console.log("[Build] Running npm install...");
            await execAsync("npm install --ignore-scripts", { cwd: outDir, timeout: 180000 });
            console.log("[Build] npm install complete.");
        }
        console.log("[Build] Running tsc --noEmit...");
        await execAsync("npx tsc -p tsconfig.app.json --noEmit", { cwd: outDir, timeout: 60000 });
        console.log("[Build] Type check passed.");
        return { success: true, errors: "", errorFiles: [] };
    } catch (error: any) {
        const allOutput = `${error.stdout || ""}\n${error.stderr || ""}`;
        const errorFileSet = new Set<string>();
        const errorLineRegex = /^(src\/[^\s(]+)/gm;
        let m;
        while ((m = errorLineRegex.exec(allOutput)) !== null) errorFileSet.add(m[1]);
        console.log(`[Build] Type check failed. ${errorFileSet.size} files with errors.`);
        // Keep first 6000 + last 2000 chars so tsc's "Found N errors" summary isn't truncated
        let truncated = allOutput;
        if (allOutput.length > 8000) {
            truncated = allOutput.substring(0, 6000) + "\n\n... [truncated] ...\n\n" + allOutput.substring(allOutput.length - 2000);
        }
        return { success: false, errors: truncated, errorFiles: [...errorFileSet] };
    }
}

// --- Step 3: Build Fixer ---

async function fixBuildErrors(outDir: string, model: any, buildResult: BuildCheckResult, sharedFiles?: Record<string, string>): Promise<string[]> {
    const fileContents: Record<string, string> = {};
    for (const f of buildResult.errorFiles.slice(0, 10)) {
        const full = path.join(outDir, f);
        if (fs.existsSync(full)) fileContents[f] = fs.readFileSync(full, "utf-8");
    }
    if (Object.keys(fileContents).length === 0) return [];

    const filesSection = Object.entries(fileContents)
        .map(([name, content]) => `### ${name}\n\`\`\`tsx\n${content}\n\`\`\``)
        .join("\n\n");

    // Include shared context files (types, api helpers, auth) so the fixer can see
    // the actual interfaces and helpers that error files depend on
    const shared = sharedFiles || readSharedFiles(outDir);
    // Exclude files already in the error set to avoid duplication
    const contextSection = Object.entries(shared)
        .filter(([name]) => !fileContents[name])
        .map(([name, content]) => `### ${name}\n\`\`\`tsx\n${content}\n\`\`\``)
        .join("\n\n");

    console.log(`[Build Fixer] Fixing ${Object.keys(fileContents).length} files (${Object.keys(shared).length} shared context files)...`);
    const { text } = await generateText({
        model,
        system: BUILD_SYSTEM_PROMPT,
        prompt: `Fix the TypeScript compilation errors in these files.\n\n## Errors\n\`\`\`\n${buildResult.errors}\n\`\`\`\n\n## Files with errors\n${filesSection}\n\n## Shared context files (read-only — do NOT modify these unless they contain errors)\n${contextSection || "(none)"}\n\n## Instructions\n- Fix ONLY the compilation errors. Do NOT change application logic.\n- Use the shared context files to understand the correct types, interfaces, and API helpers.\n- Output the COMPLETE fixed file for each file using <dyad-write> tags.\n- Do NOT add imports for packages that aren't in the project's package.json.`,
    });

    const patches = parseTags(text);
    const modified: string[] = [];
    for (const patch of patches) {
        const fp = path.join(outDir, patch.path);
        fs.ensureDirSync(path.dirname(fp));
        fs.writeFileSync(fp, patch.content);
        modified.push(patch.path);
        console.log(`[Build Fixer] Patched ${patch.path}`);
    }
    return modified;
}

// --- Step 4: Route Mapping via Flash LLM ---

const routeMapSchema = z.object({
    mappings: z.array(z.object({
        nodeId: z.string().describe("The app graph node id"),
        componentName: z.string().describe("The React component name from App.tsx imports"),
        filePath: z.string().describe("Resolved file path, e.g. src/pages/Login.tsx"),
    })),
    unmappedNodes: z.array(z.string()).describe("Node IDs that have no matching route or component in App.tsx"),
});

async function buildRouteMap(outDir: string, appGraph: any, flashModel: any): Promise<RouteMapResult> {
    const warnings: string[] = [];

    const appTsxPath = path.join(outDir, "src/App.tsx");
    if (!fs.existsSync(appTsxPath)) {
        warnings.push("App.tsx not found.");
        return { mappings: [], unmappedNodes: appGraph.nodes.map((n: any) => n.id), warnings };
    }
    const appTsxContent = fs.readFileSync(appTsxPath, "utf-8");
    const nodesSummary = appGraph.nodes.map((n: any) => ({ id: n.id, path: n.path, description: n.description }));

    try {
        console.log(`[Route Map] Asking Flash to map ${nodesSummary.length} nodes...`);
        const { object } = await generateObject({
            model: flashModel,
            schema: routeMapSchema,
            prompt: `Map each app graph node to its React component file based on the routing in App.tsx.

## App.tsx
\`\`\`tsx
${appTsxContent}
\`\`\`

## App Graph Nodes
\`\`\`json
${JSON.stringify(nodesSummary, null, 2)}
\`\`\`

## Instructions
For each node:
1. Find the <Route> in App.tsx whose path matches the node's path (note: {param} in graph = :param in React Router).
2. Identify which component is rendered at that route.
3. Resolve the component's file path from the imports at the top of App.tsx (e.g. \`import Login from "./pages/Login"\` → \`src/pages/Login.tsx\`).

Rules:
- If a node's path is "/" and it's handled by conditional redirects inside another component (not a dedicated Route), map it to the component that handles the root logic.
- If a route uses a layout wrapper, map to the actual page component, not the wrapper.
- Convert import paths: "./pages/X" → "src/pages/X.tsx", "@/pages/X" → "src/pages/X.tsx". Always include the .tsx extension.
- Only put nodes in unmappedNodes if there is truly no matching route AND no component that handles that path.`,
        });

        // Validate that mapped files actually exist on disk
        const validMappings: RouteMapEntry[] = [];
        const unmapped: string[] = [...object.unmappedNodes];

        for (const m of object.mappings) {
            const full = path.join(outDir, m.filePath);
            if (fs.existsSync(full)) {
                const nodePath = nodesSummary.find((n: any) => n.id === m.nodeId)?.path || "?";
                validMappings.push({ nodeId: m.nodeId, nodePath, componentName: m.componentName, filePath: m.filePath });
            } else {
                warnings.push(`Flash mapped "${m.nodeId}" → ${m.filePath} but file doesn't exist.`);
                unmapped.push(m.nodeId);
            }
        }

        console.log(`[Route Map] Flash: ${validMappings.length} mapped, ${unmapped.length} unmapped.`);
        if (warnings.length > 0) console.warn("[Route Map] Warnings:", warnings.join("; "));
        return { mappings: validMappings, unmappedNodes: unmapped, warnings };
    } catch (error: any) {
        console.error("[Route Map] Flash mapping failed:", error.message);
        warnings.push(`Flash route mapping failed: ${error.message}`);
        return { mappings: [], unmappedNodes: appGraph.nodes.map((n: any) => n.id), warnings };
    }
}

// --- Step 5: Per-node Reviewer ---

async function reviewNode(
    model: any,
    node: any,
    edges: any[],
    pageContent: string,
    pageFile: string,
    sharedFiles: Record<string, string>,
    openapiContent: string,
    endpointContext: NodeEndpointContext,
): Promise<NodeReview> {
    const sharedSection = Object.entries(sharedFiles)
        .map(([name, content]) => `### ${name}\n\`\`\`tsx\n${content}\n\`\`\``)
        .join("\n\n");

    try {
        const { object } = await generateObject({
            model,
            schema: nodeReviewSchema,
            system: `You are a strict frontend code reviewer. You verify generated React code matches its specification exactly. Treat the OpenAPI spec as a strict contract, not guidance. Any mismatch with endpoint method/path/parameter location/request schema/value constraints/content-type/status handling is a real issue. Mark every API contract mismatch as severity "critical". Report ONLY real issues. If everything is correct, return verdict "pass" with an empty issues array.`,
            prompt: `Review this page for correctness.

## App Graph Node
\`\`\`json
${JSON.stringify(node, null, 2)}
\`\`\`

## Outgoing Edges
\`\`\`json
${JSON.stringify(edges, null, 2)}
\`\`\`

## Page Component (${pageFile})
\`\`\`tsx
${pageContent}
\`\`\`

## Shared Context Files
${sharedSection}

## Precomputed Endpoint Targets For This Node
${endpointContext.refsText}

## Precomputed OpenAPI Operation Snippets For This Node
\`\`\`yaml
${endpointContext.openApiSnippetsText}
\`\`\`

## Full OpenAPI Specification (fallback reference)
\`\`\`yaml
${openapiContent}
\`\`\`

## Checklist
1. Route exists in App.tsx at "${normalizeAppGraphPath(node.path)}"?
2. Page fetches ALL data_requirements on load: ${JSON.stringify(node.data_requirements || [])}?
3. For EACH edge: UI trigger exists? Condition checked? Correct API endpoint called? on_success / on_error handled?
3a. Use "Precomputed Endpoint Targets For This Node" and "Precomputed OpenAPI Operation Snippets" as the PRIMARY contract scope for this node. Use full OpenAPI as fallback for shared/global cross-checks.
4. API contract strictness for every request this page triggers (directly or through shared helpers):
   - HTTP method and path exactly match OpenAPI.
   - Path/query/header/body parameters are sent in the correct location with correct names.
   - Request body strictly matches schema: required fields, types, enum values, nullable rules, nested shape, and documented constraints (minimum/maximum, minLength/maxLength, etc.).
   - Request content-type/encoding matches endpoint requirements (e.g. application/json vs multipart/form-data).
   - Every button/form sends the correct request format for its endpoint.
   - Values never violate documented bounds (example: rating must be 0-5 if endpoint max is 5, never 0-10).
   - No undocumented fields or made-up endpoint behavior.
5. Response/status handling matches endpoint contract (success and error statuses, including branch behavior)?
6. Conditional edges guarded by loading check? (no redirect while data is still loading)
7. Time-series data sorted by timestamp before rendering?
8. Uses getMediaUrl() for media paths, uploadFile() for file uploads?
9. Error handling uses ApiError.status to distinguish 401/403 from 404?
10. Environment variable is VITE_API_URL (not VITE_API_BASE_URL)?
11. No unused buttons/CTAs: every visible button/link has a corresponding edge, and no edges are missing UI triggers?
12. Media flows correct: image/file uploads use uploadFile() + stored URL, and rendering uses getMediaUrl() for any backend media path?
13. No unnecessary data loads: avoid extra API calls not in data_requirements unless justified by a listed edge or explicit UI action?
14. Delete safety: delete actions must refresh data or navigate to a safe node; never leave the user on a page that depends on deleted data?
15. Create-then-navigate safety: when a mutation creates a resource and navigates to a page that lists/shows it, is the created resource passed via navigation state and merged into the destination's data to avoid showing stale results?
16. Shared context files: review shared files (App.tsx, api helpers, layout, auth context, etc.) and report any issues that violate the checklist items above, even if the impact is global or not specific to this node?
17. Severity rule: if any API contract mismatch exists, it must be reported as severity "critical" and verdict must be "fail".`,
        });
        return object as NodeReview;
    } catch (error: any) {
        console.error(`[Reviewer] Failed to review node "${node.id}":`, error.message);
        return {
            nodeId: node.id,
            issues: [{ severity: "warning", file: pageFile, description: `Review failed: ${error.message}`, expected: "Review succeeds", actual: "Review threw an error" }],
            verdict: "fail",
        };
    }
}

// --- Step 6: Surgical Node Fixer (per-node, search-and-replace edits) ---

const nodeFixSchema = z.object({
    edits: z.array(z.object({
        file: z.string().describe("File path to edit, e.g. src/pages/Login.tsx"),
        search: z.string().describe("Exact existing code snippet to find in the file (must match including whitespace)"),
        replace: z.string().describe("Code to replace it with. Use empty string to delete the snippet."),
    })),
});

async function fixNodeWithEdits(
    outDir: string,
    model: any,
    review: NodeReview,
    node: any,
    edges: any[],
    pageFile: string,
    sharedFiles: Record<string, string>,
    openapiContent: string,
    endpointContext: NodeEndpointContext,
): Promise<{ applied: number; failed: number; filesChanged: string[] }> {
    const fullPath = path.join(outDir, pageFile);
    if (!fs.existsSync(fullPath)) return { applied: 0, failed: 0, filesChanged: [] };
    const fileContent = fs.readFileSync(fullPath, "utf-8");

    const issuesText = review.issues.map(issue =>
        `- [${issue.severity}] ${issue.description}\n  Expected: ${issue.expected}\n  Actual: ${issue.actual}`
    ).join("\n");

    const contextSection = Object.entries(sharedFiles)
        .filter(([name]) => name !== pageFile)
        .map(([name, content]) => `### [SHARED] ${name}\n\`\`\`tsx\n${content}\n\`\`\``)
        .join("\n\n");

    try {
        const { object } = await generateObject({
            model,
            schema: nodeFixSchema,
            prompt: `Fix the following issues using SURGICAL search-and-replace edits. Do NOT rewrite the entire file.

## Issues to fix
${issuesText}

## Current file (NODE)
\`\`\`tsx
${fileContent}
\`\`\`

## App Graph Node
\`\`\`json
${JSON.stringify(node, null, 2)}
\`\`\`

## Outgoing Edges
\`\`\`json
${JSON.stringify(edges, null, 2)}
\`\`\`

## Shared context files (read-only reference)
${contextSection || "(none)"}

## Precomputed Endpoint Targets For This Node
${endpointContext.refsText}

## Precomputed OpenAPI Operation Snippets For This Node
\`\`\`yaml
${endpointContext.openApiSnippetsText}
\`\`\`

## Full OpenAPI Specification (fallback reference)
\`\`\`yaml
${openapiContent}
\`\`\`

## Instructions
- Output the MINIMUM edits needed to fix the listed issues.
- Each edit's "search" must be an EXACT substring of the current file (including whitespace and indentation).
- Include enough surrounding context in "search" to be unique (at least 2-3 lines).
- For adding new code, find the insertion point, include surrounding lines in "search", and add the new code in "replace".
- All edits should target "${pageFile}" unless the fix requires changing a different file.
- Do NOT fix things that aren't listed as issues. Do NOT reorganize or reformat code.
- Shared files may have been changed by another fix in parallel, so an issue can already be resolved. If a suggested shared-file change appears to be already applied, do NOT output any edit for it.
- Prioritize endpoint contract fixes for operations listed in "Precomputed Endpoint Targets For This Node".
- Treat OpenAPI as strict contract. For API-related issues, fix method/path/parameter location/request schema/value bounds/content-type/status handling to exactly match the spec.
- Ensure each button/form sends the exact endpoint payload shape and format required by OpenAPI.
- Add or tighten client-side guards when needed to prevent out-of-contract values from being sent (example: rating above endpoint max).
- Do NOT invent undocumented endpoint fields, parameters, status semantics, or response assumptions.`,
        });

        let currentContent = fileContent;
        const filesChanged: string[] = [];
        let applied = 0;
        let failed = 0;

        for (const edit of object.edits) {
            const targetFile = edit.file || pageFile;

            if (targetFile === pageFile) {
                const replaceResult = replaceOnceWithNormalization(currentContent, edit.search, edit.replace);
                if (replaceResult.mode) {
                    currentContent = replaceResult.updated;
                    applied++;
                    if (replaceResult.mode === "normalized") {
                        console.log(`[Node Fixer] "${review.nodeId}": applied normalized match in ${targetFile}`);
                    }
                } else {
                    console.warn(`[Node Fixer] "${review.nodeId}": search string not found in ${targetFile} (${edit.search.substring(0, 60).replace(/\n/g, "\\n")}...)`);
                    failed++;
                }
            } else {
                // Edit targeting a different file (rare but possible, e.g. api.ts)
                const targetPath = path.join(outDir, targetFile);
                if (fs.existsSync(targetPath)) {
                    let otherContent = fs.readFileSync(targetPath, "utf-8");
                    const replaceResult = replaceOnceWithNormalization(otherContent, edit.search, edit.replace);
                    if (replaceResult.mode) {
                        otherContent = replaceResult.updated;
                        fs.writeFileSync(targetPath, otherContent);
                        if (!filesChanged.includes(targetFile)) filesChanged.push(targetFile);
                        applied++;
                        if (replaceResult.mode === "normalized") {
                            console.log(`[Node Fixer] "${review.nodeId}": applied normalized match in ${targetFile}`);
                        }
                    } else {
                        console.warn(`[Node Fixer] "${review.nodeId}": search string not found in ${targetFile}`);
                        failed++;
                    }
                }
            }
        }

        // Write the primary page file if changed
        if (currentContent !== fileContent) {
            fs.writeFileSync(fullPath, currentContent);
            if (!filesChanged.includes(pageFile)) filesChanged.push(pageFile);
        }

        console.log(`[Node Fixer] ${review.nodeId}: ${applied} applied, ${failed} failed (${object.edits.length} total edits)`);
        return { applied, failed, filesChanged };
    } catch (error: any) {
        console.error(`[Node Fixer] Failed for "${review.nodeId}":`, error.message);
        return { applied: 0, failed: 0, filesChanged: [] };
    }
}

// --- Step 4b: Generate Missing Pages ---

async function generateMissingPages(
    outDir: string,
    model: any,
    unmappedNodeIds: string[],
    appGraph: any,
    sharedFiles: Record<string, string>,
    openapiContent: string,
): Promise<string[]> {
    if (unmappedNodeIds.length === 0) return [];

    const unmappedNodes = appGraph.nodes.filter((n: any) => unmappedNodeIds.includes(n.id));
    const unmappedEdges = appGraph.edges.filter((e: any) => unmappedNodeIds.includes(e.from));

    const nodesSection = unmappedNodes.map((n: any) =>
        `### Node: "${n.id}" (path: ${n.path})\n- Description: ${n.description}\n- Data requirements: ${JSON.stringify(n.data_requirements || [])}`
    ).join("\n\n");

    const edgesSection = JSON.stringify(unmappedEdges, null, 2);

    const sharedSection = Object.entries(sharedFiles)
        .map(([name, content]) => `### ${name}\n\`\`\`tsx\n${content}\n\`\`\``)
        .join("\n\n");

    console.log(`[Page Generator] Generating ${unmappedNodes.length} missing pages...`);

    try {
        const { text } = await generateText({
            model,
            system: BUILD_SYSTEM_PROMPT,
            prompt: `The following pages are defined in the app graph but are MISSING from the generated frontend. Generate them and update App.tsx with the new routes and imports.

## Missing Pages
${nodesSection}

## Edges for these pages
\`\`\`json
${edgesSection}
\`\`\`

## Existing Shared Files (for import references and patterns)
${sharedSection}

## OpenAPI Specification
\`\`\`yaml
${openapiContent}
\`\`\`

## Instructions
- For EACH missing page, generate a complete React component using <dyad-write path="src/pages/PageName.tsx">.
- ALSO output an updated App.tsx using <dyad-write path="src/App.tsx"> that adds the import and <Route> for each new page.
- Use the same patterns as the existing pages (api.ts helpers, AuthContext, React Router, etc.).
- Use the app graph node paths as the route paths. Convert {id} to :id for React Router.
- Implement all data_requirements as API calls on mount.
- Implement all edges (triggers, conditions, actions, on_success, on_error).
- Do NOT modify or rewrite existing pages — only add new ones and update App.tsx routing.`,
        });

        const patches = parseTags(text);
        const generated: string[] = [];
        for (const patch of patches) {
            const fp = path.join(outDir, patch.path);
            fs.ensureDirSync(path.dirname(fp));
            // Apply safety net transforms to new files too
            let content = patch.content;
            content = content.replace(/index\.css/g, "globals.css");
            content = content.replace(/VITE_API_BASE_URL/g, "VITE_API_URL");
            content = content.replace(/VITE_BACKEND_URL/g, "VITE_API_URL");
            fs.writeFileSync(fp, content);
            generated.push(patch.path);
            console.log(`[Page Generator] Wrote ${patch.path}`);
        }
        return generated;
    } catch (error: any) {
        console.error("[Page Generator] Failed:", error.message);
        return [];
    }
}

// --- Step 7+8: Review/Fix Loop Orchestration + Final Build Gate ---

async function runReviewFixLoop(
    outDir: string,
    model: any,
    flashModel: any,
    appGraphJson: string,
    openapiContent: string,
    generatedFiles: string[],
    reviewConcurrency: number,
): Promise<ReviewResults> {
    const effectiveReviewConcurrency = Math.max(1, reviewConcurrency);
    console.log(`[Review Loop] Using review concurrency: ${effectiveReviewConcurrency}`);
    let appGraph: any;
    try { appGraph = JSON.parse(appGraphJson); }
    catch {
        console.error("[Review Loop] Invalid app graph JSON.");
        return { iterations: 0, finalVerdict: "fail", nodeReviews: [], buildErrorHistory: [{ iteration: 0, errors: "Invalid app graph JSON", source: "setup" }], fixerHistory: [] };
    }
    if (!appGraph.nodes?.length) {
        console.warn("[Review Loop] App graph has no nodes. Skipping.");
        return { iterations: 0, finalVerdict: "pass", nodeReviews: [], buildErrorHistory: [], fixerHistory: [] };
    }

    const results: ReviewResults = {
        iterations: 0, finalVerdict: "fail", nodeReviews: [],
        buildErrorHistory: [], fixerHistory: [],
    };
    // ── Phase 1: Initial Build Check + Fix ──────────────────────────
    console.log(`\n${"=".repeat(60)}\n[Phase 1] Initial Build Check\n${"=".repeat(60)}`);
    for (let attempt = 0; attempt < 3; attempt++) {
        const buildResult = await runBuildCheck(outDir, attempt === 0);
        if (buildResult.success) break;
        results.buildErrorHistory.push({ iteration: 0, errors: buildResult.errors, source: attempt === 0 ? "initial_generation" : `build_fix_${attempt}` });
        console.log(`[Phase 1] Build failed. Attempt ${attempt + 1}/3...`);
        const modified = await fixBuildErrors(outDir, model, buildResult);
        results.fixerHistory.push({ iteration: 0, filesModified: modified });
        if (modified.length === 0) { console.warn("[Phase 1] Build fixer produced no patches."); break; }
    }

    // ── Phase 2: Route Mapping ──────────────────────────────────────
    console.log(`\n${"=".repeat(60)}\n[Phase 2] Route Mapping\n${"=".repeat(60)}`);
    let routeMap = await buildRouteMap(outDir, appGraph, flashModel);

    // ── Phase 3: Generate Missing Pages ─────────────────────────────
    if (routeMap.unmappedNodes.length > 0) {
        console.log(`[Phase 3] Unmapped nodes: ${routeMap.unmappedNodes.join(", ")}`);
        const sharedCtx = readSharedFiles(outDir);
        const generated = await generateMissingPages(outDir, model, routeMap.unmappedNodes, appGraph, sharedCtx, openapiContent);
        if (generated.length > 0) {
            console.log(`[Phase 3] ${generated.length} pages generated. Build checking...`);
            for (let ba = 0; ba < 2; ba++) {
                const br = await runBuildCheck(outDir, false);
                if (br.success) break;
                results.buildErrorHistory.push({ iteration: 0, errors: br.errors, source: `page_gen_fix_${ba}` });
                const fixed = await fixBuildErrors(outDir, model, br);
                if (fixed.length === 0) break;
            }
            routeMap = await buildRouteMap(outDir, appGraph, flashModel);
            if (routeMap.unmappedNodes.length > 0) {
                console.warn(`[Phase 3] Still ${routeMap.unmappedNodes.length} unmapped: ${routeMap.unmappedNodes.join(", ")}`);
            }
        }
    }

    // ── Phases 4→5→6 Loop ─────────────────────────────────────────
    // Phase 4: Review ALL nodes.
    // Phase 5: Per-node fix loop for failing nodes (skipped if all passed).
    // Phase 6: Build check. If build fixer modified files → back to Phase 4.
    //          If build is clean → break to vite build.
    // Max 3 outer iterations to prevent infinite loops.

    const MAX_OUTER_ITERATIONS = 3;
    const mappedNodes = appGraph.nodes.filter((n: any) => !routeMap.unmappedNodes.includes(n.id));
    const unmappedReviews: NodeReview[] = routeMap.unmappedNodes.map((nodeId: string) => ({
        nodeId,
        issues: [{ severity: "critical" as const, file: "UNMAPPED", description: `No matching page file found for node "${nodeId}".`, expected: `A page component`, actual: "No file mapped" }],
        verdict: "fail" as const,
    }));
    const allReviews = new Map<string, NodeReview>();
    for (const r of unmappedReviews) allReviews.set(r.nodeId, r);
    let totalFixAttempts = 0;
    const withFixLock = createAsyncMutex();

    const runFullReview = async (label: string, scheduleFixes: boolean) => {
        console.log(`\n${"=".repeat(60)}\n${label}\n${"=".repeat(60)}`);
        const mappedFiles = new Set(routeMap.mappings.map((m: RouteMapEntry) => m.filePath));
        const sharedExtraPaths = generatedFiles.filter((p) => !mappedFiles.has(p));
        const reviewSharedFiles = readSharedFiles(outDir, sharedExtraPaths);
        const fixPromises: Promise<void>[] = [];
        const scheduled = new Set<string>();

        const scheduleFix = (
            nodeId: string,
            initialReview: NodeReview,
            node: any,
            nodeEdges: any[],
            mapping: RouteMapEntry,
            endpointContext: NodeEndpointContext,
        ) => {
            if (scheduled.has(nodeId)) return;
            scheduled.add(nodeId);
            const fixPromise = (async () => {
                for (let attempt = 0; attempt < MAX_NODE_FIX_ATTEMPTS; attempt++) {
                    const currentReview = allReviews.get(nodeId) || initialReview;
                    const nodeIssueCount = currentReview.issues.length;
                    console.log(`\n[Phase 5] "${nodeId}" attempt ${attempt + 1}/${MAX_NODE_FIX_ATTEMPTS} (${nodeIssueCount} issues)...`);

                    const fixResult = await withFixLock(() => fixNodeWithEdits(
                        outDir, flashModel || model, currentReview, node, nodeEdges,
                        mapping.filePath, readSharedFiles(outDir, sharedExtraPaths), openapiContent, endpointContext,
                    ));
                    totalFixAttempts++;
                    results.fixerHistory.push({ iteration: totalFixAttempts, filesModified: fixResult.filesChanged });

                    if (fixResult.applied === 0) {
                        console.warn(`[Phase 5] "${nodeId}": no edits applied. Skipping re-review.`);
                        break;
                    }

                    const fp = path.join(outDir, mapping.filePath);
                    const updatedContent = fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : "";
                    const reReview = await reviewNode(
                        model, node, nodeEdges, updatedContent, mapping.filePath,
                        readSharedFiles(outDir, sharedExtraPaths), openapiContent, endpointContext,
                    );
                    allReviews.set(nodeId, reReview);

                    if (reReview.verdict === "pass") {
                        console.log(`[Phase 5] "${nodeId}" PASSED after ${attempt + 1} fix(es).`);
                        break;
                    } else {
                        console.log(`[Phase 5] "${nodeId}" still failing (${reReview.issues.length} issues).`);
                    }
                }
            })();
            fixPromises.push(fixPromise);
        };

        const reviewTasks = mappedNodes.map((node: any) => () => {
            const nodeEdges = appGraph.edges.filter((e: any) => e.from === node.id);
            const endpointContext = buildNodeEndpointContext(node, nodeEdges, openapiContent);
            const mapping = routeMap.mappings.find((m: RouteMapEntry) => m.nodeId === node.id)!;
            const fp = path.join(outDir, mapping.filePath);
            const pageContent = fs.existsSync(fp) ? fs.readFileSync(fp, "utf-8") : `// FILE NOT FOUND: ${mapping.filePath}`;
            return reviewNode(model, node, nodeEdges, pageContent, mapping.filePath, reviewSharedFiles, openapiContent, endpointContext)
                .then((review) => {
                    if (scheduleFixes && review.verdict === "fail") {
                        scheduleFix(node.id, review, node, nodeEdges, mapping, endpointContext);
                    }
                    return review;
                });
        });

        const reviews = await parallelLimit<NodeReview>(reviewTasks, effectiveReviewConcurrency);
        for (const r of [...unmappedReviews, ...reviews]) allReviews.set(r.nodeId, r);

        const passCount = [...allReviews.values()].filter(r => r.verdict === "pass").length;
        const issueCount = [...allReviews.values()].reduce((s, r) => s + r.issues.length, 0);
        console.log(`[Review] ${passCount}/${allReviews.size} passed. ${issueCount} total issues.`);
        results.nodeReviews = [...allReviews.values()];

        if (fixPromises.length > 0) {
            await Promise.all(fixPromises);
        }
    };

    for (let outerIter = 0; outerIter < MAX_OUTER_ITERATIONS; outerIter++) {

        // ── Phase 4: Review ALL nodes (parallel) ─────────────────────
        await runFullReview(`[Phase 4] Reviewing all ${appGraph.nodes.length} nodes (iteration ${outerIter + 1}/${MAX_OUTER_ITERATIONS})`, true);
        const passCount = [...allReviews.values()].filter(r => r.verdict === "pass").length;
        const failCount = allReviews.size - passCount;

        // ── Phase 5: Per-Node Fix Loop (skipped if all passed) ───────
        if (failCount > 0) {
            let phase5Round = 0;
            while (phase5Round < 2) {
                phase5Round++;
                await runFullReview(`[Phase 5] Full re-review after fixes (round ${phase5Round})`, false);
                const phase5PassCount = [...allReviews.values()].filter(r => r.verdict === "pass").length;
                const phase5Issues = [...allReviews.values()].reduce((s, r) => s + r.issues.length, 0);
                console.log(`\n[Phase 5] Round ${phase5Round} done. ${phase5PassCount}/${allReviews.size} passed. ${phase5Issues} remaining issues.`);
                results.nodeReviews = [...allReviews.values()];
                results.iterations = totalFixAttempts;

                if (phase5PassCount === allReviews.size) break;
                // If still failing, re-enter fix queue using latest reviews
                await runFullReview(`[Phase 5] Queueing fixes from latest reviews (round ${phase5Round})`, true);
            }
        } else {
            console.log("[Phase 4] All nodes passed! Proceeding to build check...");
        }

        // ── Phase 6: Build Check ─────────────────────────────────────
        console.log(`\n${"=".repeat(60)}\n[Phase 6] Build Check\n${"=".repeat(60)}`);
        let buildFixerModifiedFiles = false;
        for (let attempt = 0; attempt < 3; attempt++) {
            const buildResult = await runBuildCheck(outDir, false);
            if (buildResult.success) break;
            results.buildErrorHistory.push({ iteration: outerIter + 1, errors: buildResult.errors, source: `post_fix_${attempt}` });
            console.log(`[Phase 6] Build failed. Attempt ${attempt + 1}/3...`);
            const modified = await fixBuildErrors(outDir, model, buildResult);
            if (modified.length === 0) break;
            buildFixerModifiedFiles = true;
        }

        // If build fixer didn't touch anything, build is stable → break to vite build
        if (!buildFixerModifiedFiles) {
            const currentPassCount = [...allReviews.values()].filter(r => r.verdict === "pass").length;
            results.finalVerdict = currentPassCount === allReviews.size ? "pass" : "fail";
            break;
        }

        // Build fixer modified files → loop back to Phase 4 to catch regressions
        console.log("[Phase 6] Build fixer modified files. Looping back to Phase 4 for full re-review...");

        // If this was the last outer iteration, set verdict and exit
        if (outerIter === MAX_OUTER_ITERATIONS - 1) {
            console.warn(`[Review Loop] Max outer iterations (${MAX_OUTER_ITERATIONS}) reached.`);
            const currentPassCount = [...allReviews.values()].filter(r => r.verdict === "pass").length;
            results.finalVerdict = currentPassCount === allReviews.size ? "pass" : "fail";
        }
    }

    results.nodeReviews = [...allReviews.values()];
    results.iterations = totalFixAttempts;

    // --- Final Build Gate (vite build) ---
    console.log("[Final Gate] Running vite build...");
    try {
        await execAsync("npx vite build", { cwd: outDir, timeout: 120000 });
        console.log("[Final Gate] Vite build passed.");
    } catch (error: any) {
        const buildErr = `${error.stdout || ""}\n${error.stderr || ""}`.substring(0, 8000);
        console.warn("[Final Gate] Vite build failed.");
        results.finalBuildErrors = buildErr;
        if (results.finalVerdict === "pass") results.finalVerdict = "fail";
    }

    if (results.finalVerdict === "fail") {
        const remaining = results.nodeReviews.reduce((s, r) => s + r.issues.length, 0);
        console.warn(`[Review Loop] Completed with ${remaining} unresolved issues. See review_results.json.`);
    }
    return results;
}

async function main() {
    const args = process.argv.slice(2);
    const project = args[0];
    
    // Parse arguments - support both direct JSON and file paths
    let planJson: string | undefined;
    let apiSpecJson: string | undefined;
    let openapiYamlFile: string | undefined;
    let appGraphJson: string | undefined;
    
    for (const arg of args.slice(1)) {
        if (arg.startsWith("--plan-file=")) {
            const filePath = arg.substring("--plan-file=".length);
            planJson = fs.readFileSync(filePath, "utf-8");
        } else if (arg.startsWith("--api-file=")) {
            const filePath = arg.substring("--api-file=".length);
            apiSpecJson = fs.readFileSync(filePath, "utf-8");
        } else if (arg.startsWith("--openapi-yaml-file=")) {
            openapiYamlFile = arg.substring("--openapi-yaml-file=".length);
            console.log(`OpenAPI YAML file path: ${openapiYamlFile}`);
        } else if (arg.startsWith("--app-graph-file=")) {
            const filePath = arg.substring("--app-graph-file=".length);
            try {
                appGraphJson = fs.readFileSync(filePath, "utf-8");
                console.log(`Loaded App Graph (${appGraphJson.length} chars)`);
            } catch (e) {
                console.warn("Could not load App Graph file:", e);
            }
        } else if (!planJson) {
            // Legacy support: direct JSON argument
            planJson = arg;
        } else if (!apiSpecJson) {
            // Legacy support: direct JSON argument
            apiSpecJson = arg;
        }
    }

    if (!project || !planJson) {
        console.error("Usage: ts-node generate_frontend.ts <project> --plan-file=<path> --api-file=<path> [--app-graph-file=<path>]");
        console.error("   or: ts-node generate_frontend.ts <project> <planJson> <apiSpecJson>");
        process.exit(1);
    }

    const plan = JSON.parse(planJson);
    const apiSpecRaw = apiSpecJson ? JSON.parse(apiSpecJson) : {};
    
    // Extract the actual OpenAPI content - it may be wrapped in { format, encoding, content }
    const openApiContent = apiSpecRaw.content || (typeof apiSpecRaw === 'string' ? apiSpecRaw : JSON.stringify(apiSpecRaw, null, 2));

    const scaffoldPath = path.join(__dirname, "../scaffold");
    const outDir = path.join(__dirname, "../out", project);
    const zipPath = path.join(__dirname, "../out", `${project}-frontend.zip`);

    console.log(`Generating frontend for ${project}...`);

    // 1. Copy Scaffold
    if (fs.existsSync(outDir)) {
        fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.copySync(scaffoldPath, outDir);

    // Remove node_modules from scaffold copy if they exist
    const nodeModules = path.join(outDir, "node_modules");
    if (fs.existsSync(nodeModules)) {
        fs.rmSync(nodeModules, { recursive: true, force: true });
    }

    console.log("Scaffold copied.");

    // 2. Generate Code with LLM
    const graphSection = appGraphJson ? `
## Application Structure & Interactions (PRIMARY BLUEPRINT)

This JSON graph defines the EXACT structure of the application.
- **NODES** are Pages (routes) or Components.
- **EDGES** are Interactions (Buttons, Links, Forms) that trigger transitions.

FOLLOW THIS GRAPH STRICTLY for routing, data loading, and user interactions.

\`\`\`json
${appGraphJson}
\`\`\`

---
` : '';

    // Copy openapi.yaml into the output directory for reference
    if (openapiYamlFile && fs.existsSync(openapiYamlFile)) {
        const destPath = path.join(outDir, "openapi.yaml");
        fs.copyFileSync(openapiYamlFile, destPath);
        console.log("Copied openapi.yaml into frontend repo.");
    }

    const safetyGuidelines = `
## Critical Safety & Implementation Guidelines

1. **Application Setup & Entry Point**:
   - Wrap the main \`<App />\` component in \`<BrowserRouter>\` within the entry file (\`main.tsx\` or \`index.tsx\`). Do NOT rely on \`App.tsx\` to contain the router if it also defines the routes.
   - The global stylesheet is \`globals.css\`, NOT \`index.css\`. Import it as \`import "./globals.css"\`. This file already exists in the scaffold.

2. **Authentication & Protected Routes**:
   - For protected routes, do not just render \`<Outlet />\` if the user is unauthenticated. You MUST explicitly return \`<Navigate to="/login" />\` to prevent the protected components from mounting and triggering unauthorized API calls.

3. **API Integration & Robustness**:
   - **Response Shapes**: Assume backend responses might differ slightly. Check if a field is a string (ID) or an object (populated) before accessing properties like \`._id\`.
   - **Fallback IDs**: If a documented field is missing, check if \`_id\` is the intended identifier.
   - **List Endpoints**: Handle cases where APIs return arrays of IDs instead of objects. Implement fetching mechanisms if details are needed.
   - **Defensive Coding**: Always default list responses to empty arrays (e.g., \`res.items || []\`).

4. **UI Logic & Feature Completeness**:
   - **Mutually Exclusive Actions**: Ensure opposing actions (e.g., "Join/Leave", "Activate/Deactivate") are mutually exclusive in the UI.
   - **Self-Reference Logic**: Robustly check if a resource belongs to the current user before showing actions that imply interaction with *others*.
   - **Navigation**: Ensure all list items are clickable/navigable to their detail views.

5. **Async State & Navigation Safety**:
   - When performing mutations (create/update/delete), await the refetch/refresh function IMMEDIATELY after the mutation succeeds to ensure the UI reflects the new state.
   - **Never navigate until all state the destination page depends on is loaded.** If a page checks for data on mount (e.g. redirects to onboarding if profile is null), navigating before that data is fetched causes false redirects. Always \`await\` all required data fetches before calling \`navigate()\`.
   - **Create-then-list race**: When a mutation creates a resource and navigates to a page that lists it, the list fetch may not include the new item yet. Pass the created resource via navigation state (e.g. \`navigate('/list', { state: { newItem: response } })\`) and merge it into the list on the destination page if it's missing from the fetch result.

6. **Layout & Overlap Prevention**:
   - Fixed/sticky elements (nav bars, floating inputs, FABs) must not overlap each other. Verify z-index stacking for every page — especially pages with both a fixed nav AND a fixed input area. Hide the nav or adjust z-indices as needed.

7. **Authentication Initialization (CRITICAL — this is the #1 source of bugs)**:
   - On app load, if a token exists in localStorage, you MUST validate it against the backend before setting \`isAuthenticated = true\`.
   - Call a profile/session endpoint (e.g. \`GET /me\` or \`GET /session\`). Inspect the HTTP status code on failure:
     - **401 or 403** → token is invalid/expired. Clear the token from localStorage. User is UNAUTHENTICATED → show landing/login.
     - **404** → token is valid but the resource (e.g. profile) doesn't exist yet. User IS authenticated but needs onboarding.
     - **Any other error** → treat as transient. Do NOT clear the token, do NOT set authenticated.
   - NEVER silently swallow errors from token validation. If you wrap the call in try/catch, you MUST inspect the caught error's status code using \`e instanceof ApiError && e.status\` and branch accordingly. Import \`ApiError\` from \`./api\` or \`../lib/api\`.
   - NEVER set \`isAuthenticated = true\` until the backend has confirmed the token works (i.e. returned 200 or 404 — not a network error or 401).
   - The auth state machine has exactly 3 outcomes on load: (1) no token → unauthenticated, (2) valid token + profile exists → authenticated, (3) valid token + no profile → authenticated + needs onboarding.

8. **Data Ordering**:
   - Time-series data (messages, posts, comments, notifications, activity feeds) MUST be sorted by their timestamp field (e.g. \`createdAt\`, \`sentAt\`, \`timestamp\`) before rendering.
   - Sort on the client after fetching: \`.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())\`.
   - For chat/messaging: oldest messages at the top, newest at the bottom. Auto-scroll to the bottom on load and on new messages.

9. **Environment Variables**:
   - The scaffold uses \`VITE_API_URL\` (not VITE_API_BASE_URL, not VITE_BACKEND_URL). Do NOT rename it.
   - The scaffold \`api.ts\` already reads \`import.meta.env.VITE_API_URL\`. Since you are extending (not replacing) api.ts, this is already handled.
`;

    const userPrompt = `
I have a design plan and OpenAPI specification for a web application. Please implement the frontend based on these.

${safetyGuidelines}

${graphSection}

## Design Plan
${JSON.stringify(plan, null, 2)}

## OpenAPI Specification
\`\`\`yaml
${openApiContent}
\`\`\`

## Implementation Requirements

1. **API Client Layer** - The scaffold already provides \`src/lib/api.ts\` with these ready-to-use helpers:
   - \`api.get/post/put/patch/delete\` — authenticated JSON requests
   - \`uploadFile(endpoint, file)\` — multipart/form-data upload (for \`format: binary\` fields)
   - \`getMediaUrl(path)\` — resolves backend media paths (e.g. \`/media/abc123\`) to full URLs
   - \`getAuthToken/setAuthToken/clearAuthToken\` — token management
   - \`ApiError\` — custom error class with a \`.status\` property (HTTP status code). All api helpers throw \`ApiError\` on failure. Use \`e instanceof ApiError && e.status === 401\` to check status codes in catch blocks.
   
   **EXTEND this file** with endpoint-specific functions. Do NOT replace it or rewrite the base helpers.
   - Use \`getMediaUrl()\` for ALL \`<img src>\`, \`<video src>\`, and avatar URLs that reference backend paths.
   - Use \`uploadFile()\` for file upload endpoints instead of building FormData manually.
   - Use \`ApiError\` and \`e.status\` to differentiate 401 (unauthorized) from 404 (not found) in auth flows.

2. **TypeScript Types** - Create a \`src/lib/types.ts\` file with:
   - Interfaces matching the OpenAPI schema definitions
   - Request/Response types for each endpoint

3. **Authentication** - If the API has auth endpoints:
   - Create an AuthContext for managing login state
   - Store token in localStorage
   - Add login/logout/register pages if in the plan

4. **Pages & Components** - Implement pages from the plan:
   - Use React Router for navigation
   - Call the API client functions (not mock data)
   - Handle loading and error states
   - Use the TypeScript types you defined
   - **File uploads**: For forms with file fields, render \`<input type="file" accept="image/*">\` and use \`uploadFile()\` from api.ts on submit.
   - **Media display**: Use \`getMediaUrl()\` from api.ts for all \`<img src>\` and \`<video src>\` that reference backend paths like \`/media/{id}\`.

5. **Update App.tsx** with proper routing for all pages

IMPORTANT: Generate REAL API calls using the api.ts client, not mock data. The scaffold api.ts already handles BASE_URL, auth tokens, file uploads, and media URL resolution — use those helpers, don't rewrite them.
    `;

    // Set up LLM models (Pro for generation/review, Flash for lightweight tasks like route mapping)
    const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    let model: any;
    let flashModel: any;
    if (geminiKey) {
         const google = createGoogleGenerativeAI({ apiKey: geminiKey });
         model = process.env.GEMINI_MODEL ? google(process.env.GEMINI_MODEL) : google("gemini-2.5-pro");
         flashModel = process.env.GEMINI_MODEL_FLASH ? google(process.env.GEMINI_MODEL_FLASH) : google("gemini-2.0-flash");
         console.log(`Using Gemini — Pro: ${process.env.GEMINI_MODEL || "gemini-2.5-pro"}, Flash: ${process.env.GEMINI_MODEL_FLASH || "gemini-2.0-flash"}`);
    }
    const { tier: geminiTier, maxWorkers: maxParallelWorkers } =
        resolveParallelWorkersFromTier(process.env.GEMINI_TIER);
    console.log(`[Concurrency] GEMINI_TIER=${geminiTier}; max parallel workers=${maxParallelWorkers}`);

    // Track all files written by the initial generation
    const generatedFiles: string[] = [];

    try {
        if (!model) {
            console.warn("No GEMINI_API_KEY found. Skipping LLM generation.");
        } else {
            console.log("Calling LLM...");
            const { text } = await generateText({
                model,
                system: BUILD_SYSTEM_PROMPT,
                prompt: userPrompt,
            });

            console.log("LLM response received. Length:", text.length);
            console.log("Raw Response Preview:", text.substring(0, 500));
            fs.writeFileSync(path.join(outDir, "debug_llm_response.txt"), text);

            console.log("Parsing tags...");
            const updates = parseTags(text);
            console.log(`Found ${updates.length} updates.`);

            const thirdPartyImports = new Set<string>();
            for (const update of updates) {
                const filePath = path.join(outDir, update.path);
                fs.ensureDirSync(path.dirname(filePath));
                let content = update.content.replace(/^```\w*\n/, "").replace(/\n```$/, "");
                content = content.replace(/index\.css/g, "globals.css");
                content = content.replace(/VITE_API_BASE_URL/g, "VITE_API_URL");
                content = content.replace(/VITE_BACKEND_URL/g, "VITE_API_URL");
                fs.writeFileSync(filePath, content);
                console.log(`Wrote ${update.path}`);
                generatedFiles.push(update.path); // Step 1: Track generated files
                // Collect third-party package imports (not relative paths, not @/ alias)
                const importRegex = /(?:from\s+['"]|require\s*\(\s*['"])([^./'"@][^'"]*|@[^/'"]+\/[^'"]+)['"]/g;
                let im;
                while ((im = importRegex.exec(content)) !== null) {
                    // Extract the package name (e.g. "axios", "@tanstack/react-query")
                    const spec = im[1];
                    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
                    thirdPartyImports.add(pkgName);
                }
            }

            // Auto-add any third-party packages the LLM imported that aren't in package.json
            if (thirdPartyImports.size > 0) {
                const pkgPath = path.join(outDir, "package.json");
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
                    const missing = [...thirdPartyImports].filter(p => !allDeps[p]);
                    if (missing.length > 0) {
                        pkg.dependencies = pkg.dependencies || {};
                        for (const dep of missing) {
                            pkg.dependencies[dep] = "latest";
                            console.log(`Post-processing: Added missing dependency "${dep}" to package.json`);
                        }
                        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
                    }
                }
            }
        }
    } catch (error) {
        console.error("LLM generation failed:", error);
    }

    // 3. Review/Fix Loop — build verification + per-node semantic review
    if (model && appGraphJson && generatedFiles.length > 0) {
        if (maxParallelWorkers <= 0) {
            console.log("GEMINI_TIER=0 disables frontend fixing/review loop. Skipping.");
        } else {
        try {
            console.log(`\nStarting review/fix loop (${generatedFiles.length} generated files, app graph present)...`);
            const reviewResults = await runReviewFixLoop(
                outDir,
                model,
                flashModel,
                appGraphJson,
                openApiContent,
                generatedFiles,
                maxParallelWorkers,
            );
            fs.writeFileSync(path.join(outDir, "review_results.json"), JSON.stringify(reviewResults, null, 2));
            console.log(`Review loop complete. Verdict: ${reviewResults.finalVerdict}. Results written to review_results.json.`);
        } catch (error) {
            console.error("Review/fix loop failed:", error);
        }
        }
    } else {
        if (!appGraphJson) console.log("No app graph — skipping review loop.");
        if (generatedFiles.length === 0 && model) console.log("No files generated — skipping review loop.");
    }

    // 4. Zip
    console.log("Zipping...");
    fs.ensureDirSync(path.dirname(zipPath));

    // Remove node_modules before zipping (large, not needed in artifact)
    const nmPath = path.join(outDir, "node_modules");
    if (fs.existsSync(nmPath)) {
        console.log("Removing node_modules before zip...");
        fs.rmSync(nmPath, { recursive: true, force: true });
    }

    try {
        await execAsync(`zip -r "${zipPath}" .`, { cwd: outDir });
        console.log(`Artifact created at ${zipPath}`);
    } catch (error) {
        console.error("Zip failed:", error);
        process.exit(1);
    }

    console.log(JSON.stringify({ success: true, artifactPath: zipPath }));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
