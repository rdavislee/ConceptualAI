
import fs from "fs-extra";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { openai } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
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

    try {
        const openaiKey = process.env.OPENAI_API_KEY;
        const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;

        let model;
        if (geminiKey) {
             console.log("Using Gemini model...");
             const google = createGoogleGenerativeAI({
                 apiKey: geminiKey
             });
             model = process.env.GEMINI_MODEL ? google(process.env.GEMINI_MODEL) : google("gemini-2.5-pro");
        } else if (openaiKey) {
             console.log("Using OpenAI model...");
             model = openai("gpt-4o");
        }

        if (!model) {
            console.warn("No API Key (OPENAI_API_KEY or GEMINI_API_KEY) found. Skipping LLM generation.");
        } else {
            console.log("Calling LLM...");
            const { text } = await generateText({
                model,
                system: BUILD_SYSTEM_PROMPT,
                prompt: userPrompt,
            });

            console.log("LLM response received. Length:", text.length);
            console.log("Raw Response Preview:", text.substring(0, 500));
            // Save raw response to a file for deeper inspection if needed
            fs.writeFileSync(path.join(outDir, "debug_llm_response.txt"), text);

            console.log("Parsing tags...");
            const updates = parseTags(text);
            console.log(`Found ${updates.length} updates.`);

            let hasAxiosImport = false;
            for (const update of updates) {
                const filePath = path.join(outDir, update.path);
                fs.ensureDirSync(path.dirname(filePath));
                // Remove potential markdown code block markers if the regex didn't catch them
                let content = update.content.replace(/^```\w*\n/, "").replace(/\n```$/, "");
                // Safety net: LLM training data uses index.css (create-react-app/vite default)
                // but this scaffold uses globals.css. Prompt tells it to use globals.css,
                // but we keep this fallback in case it ignores the instruction.
                content = content.replace(/index\.css/g, "globals.css");
                // Safety net: LLM often writes VITE_API_BASE_URL or VITE_BACKEND_URL
                // but the scaffold uses VITE_API_URL. Fix any variant.
                content = content.replace(/VITE_API_BASE_URL/g, "VITE_API_URL");
                content = content.replace(/VITE_BACKEND_URL/g, "VITE_API_URL");
                fs.writeFileSync(filePath, content);
                console.log(`Wrote ${update.path}`);
                // Track if any file imports axios
                if (content.includes("from 'axios'") || content.includes('from "axios"') || content.includes("require('axios')")) {
                    hasAxiosImport = true;
                }
            }

            // Post-processing: ensure axios is in package.json if any file imports it
            if (hasAxiosImport) {
                const pkgPath = path.join(outDir, "package.json");
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
                    if (!pkg.dependencies?.axios) {
                        pkg.dependencies = pkg.dependencies || {};
                        pkg.dependencies.axios = "^1.7.0";
                        fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
                        console.log("Post-processing: Added axios to package.json");
                    }
                }
            }
        }
    } catch (error) {
        console.error("LLM generation failed:", error);
    }

    // 3. Zip
    console.log("Zipping...");
    // Ensure output dir exists
    fs.ensureDirSync(path.dirname(zipPath));

    // Using zip command
    try {
        await execAsync(`zip -r "${zipPath}" .`, { cwd: outDir });
        console.log(`Artifact created at ${zipPath}`);
    } catch (error) {
        console.error("Zip failed:", error);
        process.exit(1);
    }

    // Output success result JSON
    console.log(JSON.stringify({ success: true, artifactPath: zipPath }));
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
