import sys
import os
import json
import tempfile
import shutil
import atexit

# DEBUG PRINT
print("[Assembling Agent] Script starting...", file=sys.stderr)

# Configure UTF-8 for stdin/stdout to handle special characters/emojis
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stdin, 'reconfigure'):
    sys.stdin.reconfigure(encoding='utf-8')

# Setup unique cache dir to prevent ANY persistence and avoid permission errors
# Must be done BEFORE importing dspy if dspy inits cache at module level
CACHE_DIR = tempfile.mkdtemp(prefix="dspy_agent_cache_")
os.environ["DSPY_CACHEDIR"] = CACHE_DIR

def cleanup_cache():
    if os.path.exists(CACHE_DIR):
        try:
            shutil.rmtree(CACHE_DIR, ignore_errors=True)
        except Exception:
            pass

atexit.register(cleanup_cache)

def main():
    print("[Assembling Agent] Imports starting...", file=sys.stderr)
    try:
        import dspy
        from typing import Dict, Any
        from dotenv import load_dotenv
        from doc_generator import DocGenerator
        
        load_dotenv()
        
        # Configure Gemini
        api_key = os.getenv("GEMINI_API_KEY")
        model_name = os.getenv("GEMINI_MODEL", "gemini-1.5-pro")

        if not api_key:
            print("Warning: GEMINI_API_KEY not found in environment variables.", file=sys.stderr)

        # Ensure model name is correctly prefixed for litellm
        if not model_name.startswith("gemini/") and "gemini" in model_name:
            model_name = f"gemini/{model_name}"

        # Explicitly disable caching, increase max_tokens for comprehensive README output
        lm = dspy.LM(model=model_name, api_key=api_key, cache=False, max_tokens=8192)
        dspy.settings.configure(lm=lm)
        
    except Exception as e:
        print(f"[Assembling Agent] Import/Config Error: {e}", file=sys.stderr)
        return

    # Read input from stdin
    print("[Assembling Agent] Waiting for input...", file=sys.stderr)
    sys.stderr.flush()
    
    try:
        input_data = sys.stdin.read()
    except Exception as e:
        print(f"[Assembling Agent] Failed to read stdin: {e}", file=sys.stderr)
        return

    if not input_data:
        print("[Assembling Agent] No input received.", file=sys.stderr)
        return

    print(f"[Assembling Agent] Received input length: {len(input_data)}", file=sys.stderr)

    try:
        request = json.loads(input_data)
        action = request.get("action")
        payload = request.get("payload")
        
        print(f"[Assembling Agent] Processing action: {action}", file=sys.stderr)
        
        # Lazy init
        print("[Assembling Agent] Initializing DSPy...", file=sys.stderr)
        generator = DocGenerator()

        if action == "generate_readme":
            print("[Assembling Agent] Generating README...", file=sys.stderr)
            result = generator.generate_readme(
                plan=json.dumps(payload.get("plan")),
                endpoints=json.dumps(payload.get("endpoints")),
                tech_stack=payload.get("tech_stack"),
                background_context=payload.get("background_context", "")
            )
            print("[Assembling Agent] README generated.", file=sys.stderr)
            print(json.dumps({"markdown": result}))
        
        else:
            print(f"[Assembling Agent] Unknown action: {action}", file=sys.stderr)
            print(json.dumps({"error": f"Unknown action: {action}"}))

    except Exception as e:
        print(f"[Assembling Agent] Error: {e}", file=sys.stderr)
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
