import os

file_path = "src/concepts/SyncGenerating/dspy/generated_examples.md"

try:
    # Try reading as utf-16 (based on the BOM ÿþ observed)
    with open(file_path, "r", encoding="utf-16") as f:
        content = f.read()
    
    # Write back as utf-8
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
        
    print(f"Successfully converted {file_path} from UTF-16 to UTF-8.")
except Exception as e:
    print(f"Error converting file: {e}")
    # Fallback: try reading as binary to debug
    with open(file_path, "rb") as f:
        head = f.read(20)
        print(f"File header bytes: {head}")
