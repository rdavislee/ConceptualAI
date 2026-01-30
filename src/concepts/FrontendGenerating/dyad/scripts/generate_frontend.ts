
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
    const project = process.argv[2];
    const planJson = process.argv[3];
    const apiSpecJson = process.argv[4];

    if (!project || !planJson) {
        console.error("Usage: ts-node generate_frontend.ts <project> <planJson> <apiSpecJson>");
        process.exit(1);
    }

    const plan = JSON.parse(planJson);
    const apiSpec = apiSpecJson ? JSON.parse(apiSpecJson) : {};

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
    const userPrompt = `
    I have a design plan for an application. Please implement the initial version based on this plan.

    Plan:
    ${JSON.stringify(plan, null, 2)}

    ${Object.keys(apiSpec).length > 0 ? `API Specification (OpenAPI):\n${JSON.stringify(apiSpec, null, 2)}` : ""}

    Implement the main pages and components described in the plan.
    Ensure you update src/App.tsx (or main router) to include the new pages.
    Use dummy data if the API client is not yet available, or mock the calls.
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
