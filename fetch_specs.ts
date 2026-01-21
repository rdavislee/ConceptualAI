import "jsr:@std/dotenv/load";

const headlessUrl = Deno.env.get("HEADLESS_URL");
if (!headlessUrl) {
    console.error("HEADLESS_URL not set");
    Deno.exit(1);
}
let url = headlessUrl;
if (url.endsWith("/")) url = url.slice(0, -1);
url += "/api/specs";

console.log(`Fetching from ${url}...`);
try {
    const res = await fetch(url);
    const text = await res.text();
    await Deno.writeTextFile("library_specs.md", text);
    console.log("Saved to library_specs.md");
} catch (e) {
    console.error(e);
}
