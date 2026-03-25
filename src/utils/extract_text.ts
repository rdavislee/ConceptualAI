import { Buffer } from "node:buffer";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

const TEXT_DECODABLE_APPLICATION_TYPES = new Set([
  "application/json",
  "application/xml",
]);

const PDF_MIME_TYPES = new Set(["application/pdf"]);

const DOCX_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/**
 * Extracts readable text from binary file data, routing to the
 * appropriate parser based on MIME type and file extension.
 *
 * - Text formats: decoded via TextDecoder
 * - PDF: parsed via pdf-parse
 * - DOCX/DOC: parsed via mammoth
 * - Unknown: attempts UTF-8 decode with `fatal: true`; returns a
 *   placeholder if the file is not valid UTF-8.
 */
export async function extractText(
  data: Uint8Array,
  mimeType: string,
  fileName?: string,
): Promise<string> {
  if (
    mimeType.startsWith("text/") ||
    TEXT_DECODABLE_APPLICATION_TYPES.has(mimeType)
  ) {
    return new TextDecoder().decode(data);
  }

  if (PDF_MIME_TYPES.has(mimeType)) {
    try {
      const result = await pdfParse(Buffer.from(data));
      return result.text ?? "";
    } catch {
      return `[Could not extract text from PDF${fileName ? `: ${fileName}` : ""}]`;
    }
  }

  if (DOCX_MIME_TYPES.has(mimeType)) {
    try {
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(data),
      });
      return result.value ?? "";
    } catch {
      return `[Could not extract text from document${fileName ? `: ${fileName}` : ""}]`;
    }
  }

  // Fallback: try UTF-8 decode with fatal flag so binary garbage throws
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return `[Binary file – text extraction not supported${fileName ? `: ${fileName}` : ""}]`;
  }
}
