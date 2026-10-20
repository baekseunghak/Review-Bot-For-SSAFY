import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./core.js";
import { parseGitlabMrUrl } from "./gitlab-context.js";

const MAX_BYTES = 512 * 1024;
const FILE_NAME = "project-specification.json";

function fail(message = "has invalid or incomplete data. Re-import the complete specification.") {
  const error = new UserError(`${FILE_NAME} ${message}`);
  error.code = "invalid_project_specification";
  throw error;
}

function requireValue(condition) { if (!condition) fail(); }

function object(value, required, optional = []) {
  requireValue(value && typeof value === "object" && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}

function name(value, maximum) {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= maximum
    && !/[\\/:\x00-\x1f\x7f]/.test(value) && value !== "." && value !== "..");
}

function validateSpecification(value) {
  object(value, ["schemaVersion", "project", "source", "sheets"]);
  requireValue(value.schemaVersion === 1);
  object(value.project, ["host", "path"]);
  const { host, path } = value.project;
  requireValue(typeof host === "string" && host.length > 0 && !host.startsWith("-")
    && typeof path === "string" && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(path)
    && path.split("/").every(part => part !== "." && part !== ".."));
  let address;
  try { address = new URL(`https://${host}`); } catch { fail(); }
  requireValue(address.host === host.toLowerCase() && address.pathname === "/"
    && !address.username && !address.password && !address.search && !address.hash);
  object(value.source, ["name", "sha256", "importedAt"]);
  name(value.source.name, 255);
  requireValue(typeof value.source.sha256 === "string" && /^[a-f0-9]{64}$/i.test(value.source.sha256)
    && typeof value.source.importedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value.source.importedAt)
    && Number.isFinite(Date.parse(value.source.importedAt)));
  requireValue(Array.isArray(value.sheets) && value.sheets.length > 0);
  const sheetNames = new Set();
  for (const sheet of value.sheets) {
    object(sheet, ["name", "rows"]);
    name(sheet.name, 31);
    requireValue(!/[?*\[\]]/.test(sheet.name) && !sheetNames.has(sheet.name.toLowerCase()) && Array.isArray(sheet.rows));
    sheetNames.add(sheet.name.toLowerCase());
    const rowNumbers = new Set();
    for (const row of sheet.rows) {
      object(row, ["row", "cells"]);
      requireValue(Number.isSafeInteger(row.row) && row.row > 0 && row.row <= 1_048_576
        && !rowNumbers.has(row.row) && Array.isArray(row.cells));
      rowNumbers.add(row.row);
      const addresses = new Set();
      for (const cell of row.cells) {
        object(cell, ["address", "value"], ["formula", "hyperlink"]);
        const match = typeof cell.address === "string" && /^([A-Z]{1,3})([1-9]\d*)$/.exec(cell.address);
        requireValue(match && Number(match[2]) === row.row && !addresses.has(cell.address));
        const column = [...match[1]].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
        requireValue(column <= 16_384);
        addresses.add(cell.address);
        requireValue(cell.value === null || ["string", "boolean"].includes(typeof cell.value)
          || (typeof cell.value === "number" && Number.isFinite(cell.value)));
        requireValue(!Object.hasOwn(cell, "formula") || typeof cell.formula === "string");
        requireValue(!Object.hasOwn(cell, "hyperlink") || typeof cell.hyperlink === "string");
      }
    }
  }
  return value;
}

export function loadProjectSpecification({ dataDir, mrUrl }) {
  if (dataDir === undefined || dataDir === null) return null;
  requireValue(typeof dataDir === "string" && dataDir.trim().length > 0);
  const filename = join(dataDir, FILE_NAME);
  let info;
  try { info = lstatSync(filename); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    fail("could not be read. Check the local specification registration.");
  }
  if (!info.isFile() || info.isSymbolicLink()) fail("must be a regular file, not a link or directory.");
  if (info.size > MAX_BYTES) fail("exceeds 512 KiB. A partial specification cannot be used.");
  let descriptor;
  let value;
  try {
    descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) fail("changed while opening. Register it again before reviewing.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) fail("exceeds 512 KiB. A partial specification cannot be used.");
    const after = fstatSync(descriptor);
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      fail("changed while reading. Register it again before reviewing.");
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
  } catch (error) {
    if (error instanceof UserError) throw error;
    fail("could not be read as complete UTF-8 JSON. Re-import the specification.");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  validateSpecification(value);
  let mr;
  try { mr = parseGitlabMrUrl(mrUrl); } catch { fail("requires a valid GitLab MR URL to check project scope."); }
  if (value.project.host.toLowerCase() !== mr.host.toLowerCase() || value.project.path !== mr.project) return null;
  return value;
}
