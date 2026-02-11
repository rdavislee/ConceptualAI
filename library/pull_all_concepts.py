#!/usr/bin/env python3
"""Pull all concepts from the concept library API into local folders.

The script uses:
- GET /api/catalog to discover all concept names
- POST /api/pull/{name} to fetch code/tests/spec per concept
- GET /api/concepts/{name}/spec as a fallback when pull response has no spec
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

try:
    from dotenv import load_dotenv
except Exception:  # pragma: no cover - optional dependency
    load_dotenv = None  # type: ignore[assignment]


INVALID_FS_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


@dataclass(frozen=True)
class ConceptMeta:
    name: str
    concept_id: str
    author: str


def normalize_base_url(raw_url: str) -> str:
    return raw_url.rstrip("/")


def safe_path_component(value: str) -> str:
    cleaned = INVALID_FS_CHARS.sub("_", value).strip().rstrip(".")
    return cleaned or "UnnamedConcept"


def build_request(url: str, method: str = "GET", body: bytes | None = None, headers: dict[str, str] | None = None) -> Request:
    merged_headers = {
        "Accept": "application/json",
        "User-Agent": "ConceptualAI-LibraryExporter/1.0",
    }
    if headers:
        merged_headers.update(headers)
    return Request(url=url, data=body, method=method, headers=merged_headers)


def request_text(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    timeout: int = 20,
    headers: dict[str, str] | None = None,
) -> str:
    request = build_request(url, method=method, body=body, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.read().decode("utf-8")
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else ""
        raise RuntimeError(f"HTTP {exc.code} for {url}: {details}") from exc
    except URLError as exc:
        raise RuntimeError(f"Network error for {url}: {exc}") from exc


def request_json(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    timeout: int = 20,
    headers: dict[str, str] | None = None,
) -> Any:
    text = request_text(url, method=method, body=body, timeout=timeout, headers=headers)
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Expected JSON response from {url}, got invalid payload.") from exc


def fetch_catalog(base_url: str, timeout: int) -> list[ConceptMeta]:
    url = f"{base_url}/api/catalog"
    payload = request_json(url, timeout=timeout)

    if not isinstance(payload, dict):
        raise RuntimeError("Catalog response must be a JSON object.")

    concepts = payload.get("concepts")
    if not isinstance(concepts, list):
        raise RuntimeError("Catalog response is missing a valid 'concepts' array.")

    items: list[ConceptMeta] = []
    for raw in concepts:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", "")).strip()
        if not name:
            continue
        items.append(
            ConceptMeta(
                name=name,
                concept_id=str(raw.get("id", "")),
                author=str(raw.get("author", "")),
            )
        )

    if not items:
        raise RuntimeError("Catalog returned zero concepts.")

    return items


def parse_concept_names_from_specs(specs_text: str) -> list[str]:
    names: list[str] = []
    marker = "--- CONCEPT: "
    for chunk in specs_text.split(marker):
        if not chunk.strip():
            continue
        header = chunk.split("\n", 1)[0].strip()
        if header.endswith(" ---"):
            concept_name = header[:-4].strip()
            if concept_name:
                names.append(concept_name)
    return names


def fetch_catalog_from_specs(base_url: str, timeout: int) -> list[ConceptMeta]:
    url = f"{base_url}/api/specs"
    specs_text = request_text(
        url,
        method="GET",
        timeout=timeout,
        headers={"Accept": "text/plain"},
    )
    names = parse_concept_names_from_specs(specs_text)
    if not names:
        raise RuntimeError("No concept names found in /api/specs response.")
    return [ConceptMeta(name=name, concept_id="", author="") for name in names]


def fetch_spec(base_url: str, concept_name: str, timeout: int) -> str:
    encoded_name = quote(concept_name, safe="")
    url = f"{base_url}/api/concepts/{encoded_name}/spec"
    return request_text(
        url,
        method="GET",
        timeout=timeout,
        headers={"Accept": "text/plain"},
    )


def fetch_pull_payload(base_url: str, concept_name: str, timeout: int) -> dict[str, str]:
    encoded_name = quote(concept_name, safe="")
    url = f"{base_url}/api/pull/{encoded_name}"
    payload = request_json(
        url,
        method="POST",
        timeout=timeout,
        body=b"{}",
        headers={"Content-Type": "application/json"},
    )

    if not isinstance(payload, dict):
        raise RuntimeError(f"Pull response for '{concept_name}' must be a JSON object.")

    code = payload.get("code", "")
    tests = payload.get("tests", "")
    spec = payload.get("spec", "")

    if not isinstance(code, str):
        code = str(code)
    if not isinstance(tests, str):
        tests = str(tests)
    if not isinstance(spec, str):
        spec = str(spec)

    if not spec:
        try:
            spec = fetch_spec(base_url, concept_name, timeout)
        except Exception:
            # Spec is still useful but not required to keep the export moving.
            spec = ""

    return {"code": code, "tests": tests, "spec": spec}


def unique_folder_name(base_name: str, assigned: set[str]) -> str:
    candidate = base_name
    suffix = 2
    while candidate.lower() in assigned:
        candidate = f"{base_name}_{suffix}"
        suffix += 1
    assigned.add(candidate.lower())
    return candidate


def write_text_file(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def write_concept_files(
    output_dir: Path,
    folder_name: str,
    concept: ConceptMeta,
    payload: dict[str, str],
) -> None:
    concept_dir = output_dir / folder_name
    concept_dir.mkdir(parents=True, exist_ok=True)

    # Keep names close to existing Implementing CLI artifact conventions.
    file_base = safe_path_component(concept.name)
    code_path = concept_dir / f"{file_base}Concept.ts"
    tests_path = concept_dir / f"{file_base}.test.ts"
    spec_path = concept_dir / f"{file_base}.md"
    metadata_path = concept_dir / "metadata.json"

    write_text_file(code_path, payload["code"])
    write_text_file(tests_path, payload["tests"])
    write_text_file(spec_path, payload["spec"])

    metadata = {
        "name": concept.name,
        "id": concept.concept_id,
        "author": concept.author,
        "source": "concept-library-api",
        "pulledAt": datetime.now(timezone.utc).isoformat(),
    }
    metadata_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    default_output = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(
        description=(
            "Export every concept from the remote concept library into local per-concept folders."
        )
    )
    parser.add_argument(
        "--headless-url",
        default=os.getenv("HEADLESS_URL"),
        help="Base URL for the concept server (defaults to HEADLESS_URL env var).",
    )
    parser.add_argument(
        "--output-dir",
        default=str(default_output),
        help="Directory where concept folders are written (default: ./library).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=20,
        help="HTTP timeout in seconds for each request (default: 20).",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip writing folders that already exist.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional number of concepts to export (for quick testing).",
    )
    return parser.parse_args()


def main() -> int:
    if load_dotenv is not None:
        load_dotenv()

    args = parse_args()
    if not args.headless_url:
        print("Error: HEADLESS_URL is required (or pass --headless-url).", file=sys.stderr)
        return 1

    if args.timeout <= 0:
        print("Error: --timeout must be a positive integer.", file=sys.stderr)
        return 1

    base_url = normalize_base_url(str(args.headless_url))
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Using concept API: {base_url}")
    print(f"Writing concepts to: {output_dir}")

    try:
        catalog = fetch_catalog(base_url, args.timeout)
    except Exception as exc:
        print(f"Catalog lookup failed ({exc}). Falling back to /api/specs parsing...")
        try:
            catalog = fetch_catalog_from_specs(base_url, args.timeout)
        except Exception as fallback_exc:
            print(f"Failed to fetch concept names from /api/specs: {fallback_exc}", file=sys.stderr)
            return 1

    if args.limit is not None:
        catalog = catalog[: max(args.limit, 0)]

    print(f"Discovered {len(catalog)} concepts.")

    assigned_folders: set[str] = set()
    exported: list[dict[str, str]] = []
    failures: list[dict[str, str]] = []

    for idx, concept in enumerate(catalog, start=1):
        base_folder = safe_path_component(concept.name)
        folder_name = unique_folder_name(base_folder, assigned_folders)
        concept_dir = output_dir / folder_name

        if args.skip_existing and concept_dir.exists():
            print(f"[{idx}/{len(catalog)}] Skipped {concept.name} (folder already exists)")
            exported.append({"name": concept.name, "folder": folder_name, "status": "skipped"})
            continue

        print(f"[{idx}/{len(catalog)}] Pulling {concept.name} ...")
        try:
            payload = fetch_pull_payload(base_url, concept.name, args.timeout)
            write_concept_files(output_dir, folder_name, concept, payload)
            exported.append({"name": concept.name, "folder": folder_name, "status": "exported"})
        except Exception as exc:
            print(f"  Failed to pull {concept.name}: {exc}", file=sys.stderr)
            failures.append({"name": concept.name, "error": str(exc)})

    snapshot = {
        "sourceUrl": base_url,
        "pulledAt": datetime.now(timezone.utc).isoformat(),
        "totalCatalogConcepts": len(catalog),
        "exportedCount": len([x for x in exported if x["status"] == "exported"]),
        "skippedCount": len([x for x in exported if x["status"] == "skipped"]),
        "failedCount": len(failures),
        "concepts": exported,
        "failures": failures,
    }
    snapshot_path = output_dir / "_catalog_snapshot.json"
    snapshot_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")

    print("\nDone.")
    print(f"Snapshot written to: {snapshot_path}")
    if failures:
        print(f"Completed with {len(failures)} failures.", file=sys.stderr)
        return 1
    print("All concepts exported successfully.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
