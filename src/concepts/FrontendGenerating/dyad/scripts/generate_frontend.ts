
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
    let frontendGuide: string | undefined;
    
    for (const arg of args.slice(1)) {
        if (arg.startsWith("--plan-file=")) {
            const filePath = arg.substring("--plan-file=".length);
            planJson = fs.readFileSync(filePath, "utf-8");
        } else if (arg.startsWith("--api-file=")) {
            const filePath = arg.substring("--api-file=".length);
            apiSpecJson = fs.readFileSync(filePath, "utf-8");
        } else if (arg.startsWith("--guide-file=")) {
            const filePath = arg.substring("--guide-file=".length);
            try {
                frontendGuide = fs.readFileSync(filePath, "utf-8");
                console.log(`Loaded frontend guide (${frontendGuide.length} chars)`);
            } catch (e) {
                console.warn("Could not load frontend guide file:", e);
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
        console.error("Usage: ts-node generate_frontend.ts <project> --plan-file=<path> --api-file=<path> [--guide-file=<path>]");
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
    // Build the frontend guide section if available
    const guideSection = frontendGuide ? `
## Frontend API Usage Guide (CRITICAL - Follow This Exactly!)

This guide specifies EXACTLY which API calls to make for each user flow.
Follow this guide precisely - do not guess or make assumptions about API calls.

${frontendGuide}

---
` : '';

    const userPrompt = `
I have a design plan, OpenAPI specification, and API usage guide for a web application. Please implement the frontend based on these.

${guideSection}
## Design Plan
${JSON.stringify(plan, null, 2)}

## OpenAPI Specification
\`\`\`yaml
${openApiContent}
\`\`\`

## Implementation Requirements

1. **API Client Layer** - Create a \`src/lib/api.ts\` file with:
   - **CRITICAL - USE ENVIRONMENT VARIABLE FOR BASE_URL:**
     \`\`\`typescript
     // CORRECT - uses environment variable with /api suffix
     const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';
     
     // WRONG - hardcoded, DO NOT DO THIS:
     // const BASE_URL = 'http://localhost:8000';
     \`\`\`
   - The backend serves all routes under /api/* so the BASE_URL MUST include /api
   - Type-safe API functions for each endpoint defined in the OpenAPI spec
   - Proper error handling that throws on non-2xx responses
   - Include Authorization header with token from localStorage if available

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
${frontendGuide ? `
5. **CRITICAL - Follow the API Usage Guide above!**
   - Each user flow specifies EXACTLY which API calls to make
   - Make sure to call ALL necessary endpoints in the correct sequence
   - Handle all the responses as documented in the guide
` : ''}
6. **Update App.tsx** with proper routing for all pages

IMPORTANT: Generate REAL API calls using the api.ts client, not mock data.
${frontendGuide ? 'IMPORTANT: Follow the Frontend API Usage Guide exactly for each user flow!' : ''}

REMINDER - API BASE_URL MUST use environment variable:
\`\`\`typescript
const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';
\`\`\`
DO NOT hardcode 'http://localhost:8000' without the /api suffix!
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

            for (const update of updates) {
                const filePath = path.join(outDir, update.path);
                fs.ensureDirSync(path.dirname(filePath));
                // Remove potential markdown code block markers if the regex didn't catch them
                let content = update.content.replace(/^```\w*\n/, "").replace(/\n```$/, "");
                fs.writeFileSync(filePath, content);
                console.log(`Wrote ${update.path}`);
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
