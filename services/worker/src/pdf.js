/**
 * PDF tools wrapper.
 *
 * Why ExifTool:
 * - best practical tool to remove/edit metadata in PDFs (including XMP)
 *
 * Why QPDF rewrite:
 * - ensures final output is normalized and rewritten
 *
 * Why timeouts:
 * - corrupted PDFs can hang CLI tools => "zombie processes"
 * - timeout guarantees the worker continues and retries/marks failed
 */
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const EXIFTOOL_TIMEOUT_MS = Number(process.env.EXIFTOOL_TIMEOUT_MS || 60_000);
const QPDF_TIMEOUT_MS = Number(process.env.QPDF_TIMEOUT_MS || 60_000);

/**
 * Basic spoof-protection:
 * - content-type in browser can be faked
 * - checking magic header catches many non-PDF files
 */
export function assertPdfMagicHeader(filePath) {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(5);
  fs.readSync(fd, buf, 0, 5, 0);
  fs.closeSync(fd);

  if (buf.toString("utf8") !== "%PDF-") {
    throw new Error("Not a PDF (magic header mismatch)");
  }
}

/**
 * removeOrEditMetadata
 * - REMOVE: clears ALL tags + XMP, plus explicit common fields
 * - EDIT: sets only fields provided
 *
 * Why output file:
 * - never mutate original, always create new file
 */
export async function removeOrEditMetadata({
  inPath,
  outPath,
  operation,
  edit,
}) {
  if (operation === "REMOVE") {
    const args = [
      "-all=",
      "-xmp:all=",
      "-Author=",
      "-Title=",
      "-Subject=",
      "-Keywords=",
      "-Creator=",
      "-Producer=",
      "-CreateDate=",
      "-ModifyDate=",
      "-o",
      outPath,
      inPath,
    ];
    await execFileAsync("exiftool", args, { timeout: EXIFTOOL_TIMEOUT_MS });
    return;
  }

  const args = ["-o", outPath];

  if (edit?.author) args.push(`-Author=${edit.author}`);
  if (edit?.title) args.push(`-Title=${edit.title}`);
  if (edit?.subject) args.push(`-Subject=${edit.subject}`);
  if (edit?.keywords) args.push(`-Keywords=${edit.keywords}`);
  if (edit?.creator) args.push(`-Creator=${edit.creator}`);
  if (edit?.producer) args.push(`-Producer=${edit.producer}`);

  args.push(inPath);

  await execFileAsync("exiftool", args, { timeout: EXIFTOOL_TIMEOUT_MS });
}

/**
 * qpdfRewrite
 * - linearize / rewrite final pdf
 * Why:
 * - stable output, compatibility improvements
 */
export async function qpdfRewrite({ inPath, outPath }) {
  await execFileAsync("qpdf", ["--linearize", inPath, outPath], {
    timeout: QPDF_TIMEOUT_MS,
  });
}
