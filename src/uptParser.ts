import * as fs from 'fs';
import * as path from 'path';
import { Assembly } from './assemblyParser';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface UptOption {
  type: 'bool' | 'select' | 'id';
  label: string;
  varname: string;
  default: boolean | number | string;
  choices?: string[];
}

export interface UptBlock {
  filename: string;
  optionalVar?: string;
  content: string;
}

export interface UptTemplate {
  name: string;
  sourcePath: string;
  options: UptOption[];
  blocks: UptBlock[];
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export function parseUptFile(filePath: string): UptTemplate | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split(/\r?\n/);

  // Parse template declaration: template "Name" main;
  let name = path.basename(filePath, '.upt');
  const tplMatch = raw.match(/template\s+"([^"]+)"/);
  if (tplMatch) name = tplMatch[1];

  // Only accept "main" templates
  if (!/\bmain\b/.test(raw)) return null;

  const options = parseOptions(lines);
  const blocks = parseBlocks(lines);

  return { name, sourcePath: filePath, options, blocks };
}

function parseOptions(lines: string[]): UptOption[] {
  const options: UptOption[] = [];

  // Join lines to handle multi-line select declarations
  const fullText = lines.join('\n');

  // id "Label" varname = PACKAGE;
  const idRegex = /id\s+"([^"]+)"\s+(\w+)\s*=\s*(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(fullText)) !== null) {
    options.push({
      type: 'id',
      label: m[1],
      varname: m[2],
      default: m[3], // typically "PACKAGE"
    });
  }

  // select("A", "B") "Label" varname = N;  (may span multiple lines)
  const selRegex = /select\(([^)]+)\)\s+"([^"]+)"\s+(\w+)\s*=\s*(\d+)\s*;/g;
  while ((m = selRegex.exec(fullText)) !== null) {
    const choices = m[1].split(',').map(s => s.trim().replace(/^"|"$/g, ''));
    options.push({
      type: 'select',
      label: m[2],
      varname: m[3],
      default: parseInt(m[4], 10),
      choices,
    });
  }

  // option "Label" varname = 1;
  const optDefault = /option\s+"([^"]+)"\s+(\w+)\s*=\s*(\d+)\s*;/g;
  while ((m = optDefault.exec(fullText)) !== null) {
    options.push({
      type: 'bool',
      label: m[1],
      varname: m[2],
      default: parseInt(m[3], 10) !== 0,
    });
  }

  // option "Label" varname;
  const optBool = /option\s+"([^"]+)"\s+(\w+)\s*;/g;
  while ((m = optBool.exec(fullText)) !== null) {
    options.push({
      type: 'bool',
      label: m[1],
      varname: m[2],
      default: false,
    });
  }

  return options;
}

function parseBlocks(lines: string[]): UptBlock[] {
  const blocks: UptBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // @@filename starts a new block (may have optional ??var after it)
    if (line.startsWith('@@')) {
      // Collect the filename — it may span multiple lines if there's a ??var on the next line
      let filename = line.substring(2);
      i++;

      // Check for ??varname (optional file)
      let optionalVar: string | undefined;
      if (i < lines.length && lines[i].trim().startsWith('??')) {
        optionalVar = lines[i].trim().substring(2).trim();
        i++;
      }

      // Collect content until next @@ or end
      const contentLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('@@')) {
        contentLines.push(lines[i]);
        i++;
      }

      blocks.push({
        filename,
        optionalVar,
        content: contentLines.join('\n'),
      });
    } else {
      i++;
    }
  }

  return blocks;
}

// ─── Finder ──────────────────────────────────────────────────────────────────

export function findUptTemplates(assembly: Assembly): UptTemplate[] {
  const templates: UptTemplate[] = [];
  const seen = new Set<string>();

  for (const nest of assembly.nests) {
    if (!fs.existsSync(nest)) continue;

    // Scan nest/upt/*.upt
    const uptDir = path.join(nest, 'upt');
    if (fs.existsSync(uptDir)) {
      try {
        for (const entry of fs.readdirSync(uptDir)) {
          if (!entry.endsWith('.upt')) continue;
          const full = path.join(uptDir, entry);
          if (seen.has(full)) continue;
          seen.add(full);
          const tpl = parseUptFile(full);
          if (tpl) templates.push(tpl);
        }
      } catch { /* ignore */ }
    }

    // Scan nest/*/<name>.upt (package-level templates like Core/core.upt)
    try {
      for (const entry of fs.readdirSync(nest, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(nest, entry.name);
        try {
          for (const f of fs.readdirSync(pkgDir)) {
            if (!f.endsWith('.upt')) continue;
            const full = path.join(pkgDir, f);
            if (seen.has(full)) continue;
            seen.add(full);
            const tpl = parseUptFile(full);
            if (tpl) templates.push(tpl);
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return templates;
}

// ─── Expression Evaluator ────────────────────────────────────────────────────

function evalExpr(expr: string, vars: Record<string, boolean | number | string>): boolean {
  expr = expr.trim();

  // Handle && (AND)
  const andIdx = findTopLevelOp(expr, '&&');
  if (andIdx >= 0) {
    const left = expr.substring(0, andIdx).trim();
    const right = expr.substring(andIdx + 2).trim();
    return evalExpr(left, vars) && evalExpr(right, vars);
  }

  // Handle || (OR)
  const orIdx = findTopLevelOp(expr, '||');
  if (orIdx >= 0) {
    const left = expr.substring(0, orIdx).trim();
    const right = expr.substring(orIdx + 2).trim();
    return evalExpr(left, vars) || evalExpr(right, vars);
  }

  // Handle ! (NOT) prefix
  if (expr.startsWith('!')) {
    return !evalExpr(expr.substring(1), vars);
  }

  // Handle == (equality)
  const eqMatch = expr.match(/^(\w+)\s*==\s*(\d+)\s*$/);
  if (eqMatch) {
    const val = vars[eqMatch[1]];
    if (val === undefined) return false;
    return Number(val) === parseInt(eqMatch[2], 10);
  }

  // Handle != (not equal)
  const neqMatch = expr.match(/^(\w+)\s*!=\s*(\d+)\s*$/);
  if (neqMatch) {
    const val = vars[neqMatch[1]];
    if (val === undefined) return true;
    return Number(val) !== parseInt(neqMatch[2], 10);
  }

  // Handle > comparison
  const gtMatch = expr.match(/^(\w+)\s*>\s*(\d+)\s*$/);
  if (gtMatch) {
    const val = vars[gtMatch[1]];
    if (val === undefined) return false;
    return Number(val) > parseInt(gtMatch[2], 10);
  }

  // Handle < comparison
  const ltMatch = expr.match(/^(\w+)\s*<\s*(\d+)\s*$/);
  if (ltMatch) {
    const val = vars[ltMatch[1]];
    if (val === undefined) return false;
    return Number(val) < parseInt(ltMatch[2], 10);
  }

  // Simple variable truthy check
  const val = vars[expr];
  if (val === undefined) return false;
  return !!val;
}

function findTopLevelOp(expr: string, op: string): number {
  let depth = 0;
  let inQuote = false;
  let quoteChar = '';
  for (let i = 0; i < expr.length - op.length + 1; i++) {
    const ch = expr[i];
    if (inQuote) {
      if (ch === quoteChar && expr[i - 1] !== '\\') inQuote = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      continue;
    }
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth--; continue; }
    if (depth === 0 && expr.substring(i, i + op.length) === op) {
      if (op === '&&' && i + op.length < expr.length && expr[i + op.length] === '&') continue;
      if (op === '||' && i + op.length < expr.length && expr[i + op.length] === '|') continue;
      return i;
    }
  }
  return -1;
}

// ─── Tag Finder ──────────────────────────────────────────────────────────────

/**
 * Find the end of a <:...:> tag starting from the opening <:.
 * Returns the position of the end delimiter, or -1 if not found.
 * Sets endColon to true if the closing is :> (vs just >).
 */
function findTagEnd(input: string, startAfterColon: number): { pos: number; colonClose: boolean } | null {
  // First pass: look for :> (preferred close)
  // Second pass: fall back to bare > if no :> found
  let inQuote = false;
  let quoteChar = '';
  let bareGtPos = -1;

  for (let i = startAfterColon; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      if (ch === '\\' && i + 1 < input.length) { i++; continue; }
      if (ch === quoteChar) inQuote = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      continue;
    }
    // Check for :>  (colon followed by >)
    if (ch === ':' && i + 1 < input.length && input[i + 1] === '>') {
      return { pos: i + 2, colonClose: true };
    }
    // Track first bare > (not preceded by colon) as fallback
    if (ch === '>' && bareGtPos === -1) {
      bareGtPos = i + 1;
    }
  }
  // Fallback: bare >
  if (bareGtPos !== -1) {
    return { pos: bareGtPos, colonClose: false };
  }
  return null;
}

// ─── Conditional Block Finder ────────────────────────────────────────────────

function findConditionalEnd(
  input: string,
  start: number,
): { endPos: number; elsePos: number } {
  let depth = 0;
  let elsePos = -1;
  let i = start;

  while (i < input.length) {
    const tagStart = input.indexOf('<:', i);
    if (tagStart === -1) break;

    const tagResult = findTagEnd(input, tagStart + 2);
    if (!tagResult) break;
    const tagEnd = tagResult.pos;

    const tagContent = input.substring(tagStart + 2, tagEnd - (tagResult.colonClose ? 2 : 1)).trim();

    if (tagContent.startsWith('?')) {
      depth++;
    } else if (tagContent === '.') {
      if (depth === 0) {
        return { endPos: tagStart, elsePos };
      }
      depth--;
    } else if (tagContent === '/' && depth === 0) {
      elsePos = tagEnd;
    }

    i = tagEnd;
  }

  return { endPos: input.length, elsePos };
}

// ─── Template Renderer ───────────────────────────────────────────────────────

export function renderBlocks(
  tpl: UptTemplate,
  pkgName: string,
  options: Record<string, boolean | number | string>,
): Map<string, string> {
  const files = new Map<string, string>();

  // Build the full variable map: options + resolved id variables + PACKAGE
  const vars: Record<string, boolean | number | string> = { ...options, PACKAGE: pkgName };
  for (const opt of tpl.options) {
    if (opt.type === 'id') {
      // If user provided a value, use it; otherwise resolve from default (typically PACKAGE)
      if (vars[opt.varname] === undefined || vars[opt.varname] === '') {
        const refVal = vars[opt.default as string];
        vars[opt.varname] = refVal !== undefined ? refVal : pkgName;
      }
    }
  }

  for (const block of tpl.blocks) {
    if (block.optionalVar && !vars[block.optionalVar]) continue;

    const filename = renderTemplate(block.filename, pkgName, vars);
    const content = renderTemplate(block.content, pkgName, vars);
    files.set(filename.trim(), content);
  }

  return files;
}

function renderTemplate(
  input: string,
  pkgName: string,
  vars: Record<string, boolean | number | string>,
): string {
  let result = '';
  let i = 0;

  while (i < input.length) {
    // Look for <:
    const tagStart = input.indexOf('<:', i);
    if (tagStart === -1) {
      result += input.substring(i);
      break;
    }

    result += input.substring(i, tagStart);

    // Find the matching closing >
    const tagResult = findTagEnd(input, tagStart + 2);
    if (!tagResult) {
      result += input.substring(tagStart);
      break;
    }

    // Extract tag content based on closing type
    const tagEnd = tagResult.pos;
    const contentEnd = tagResult.colonClose ? tagEnd - 2 : tagEnd - 1;
    const tagContent = input.substring(tagStart + 2, contentEnd).trim();
    i = tagEnd;

    // ?expr: — conditional start
    if (tagContent.startsWith('?')) {
      const expr = tagContent.substring(1).trim();
      const condResult = evalExpr(expr, vars);

      const { endPos, elsePos } = findConditionalEnd(input, i);

      if (condResult) {
        const branchEnd = elsePos !== -1 ? elsePos : endPos;
        const branch = input.substring(i, branchEnd);
        result += renderTemplate(branch, pkgName, vars);
      } else {
        if (elsePos !== -1) {
          const branch = input.substring(elsePos, endPos);
          result += renderTemplate(branch, pkgName, vars);
        }
      }

      i = endPos; // skip past the <:.:> end tag (findConditionalEnd returns position of <)
      continue;
    }

    // /:> — else marker (standalone, skip)
    if (tagContent === '/') {
      continue;
    }

    // .:> — end marker (standalone, skip)
    if (tagContent === '.') {
      continue;
    }

    // PACKAGE substitution
    if (tagContent === 'PACKAGE') {
      result += pkgName;
      continue;
    }

    // Variable substitution: <:varname:>
    const varVal = vars[tagContent];
    if (varVal !== undefined) {
      result += String(varVal);
      continue;
    }

    // Strip outer parentheses for expression evaluation: <:(expr):>
    let exprContent = tagContent;
    if (exprContent.startsWith('(') && exprContent.endsWith(')')) {
      exprContent = exprContent.slice(1, -1).trim();
    }

    // Ternary: expr ? "a" : "b"
    const ternMatch = exprContent.match(/^(.+?)\s*\?\s*"([^"]*)"\s*:\s*"([^"]*)"$/);
    if (ternMatch) {
      const cond = evalExpr(ternMatch[1], vars);
      result += cond ? ternMatch[2] : ternMatch[3];
      continue;
    }

    // Complex ternary with variable substitution
    const complexTernMatch = exprContent.match(/^(.+?)\s*\?\s*(.+?)\s*:\s*(.+)$/);
    if (complexTernMatch) {
      const cond = evalExpr(complexTernMatch[1], vars);
      if (cond) {
        result += evalTernaryValue(complexTernMatch[2], vars);
      } else {
        result += evalTernaryValue(complexTernMatch[3], vars);
      }
      continue;
    }

    // Unknown tag — output as-is
    result += `<:${tagContent}${tagResult.colonClose ? ':' : ''}>`;
  }

  return result;
}

function evalTernaryValue(expr: string, vars: Record<string, boolean | number | string>): string {
  expr = expr.trim();

  // Handle string concatenation with + operator
  // e.g. "With" + classname + "Layout<TopWindow>"
  if (expr.includes('+')) {
    const parts = splitTernaryConcat(expr);
    return parts.map(p => evalTernaryValue(p, vars)).join('');
  }

  // Quoted string
  if ((expr.startsWith('"') && expr.endsWith('"')) || (expr.startsWith("'") && expr.endsWith("'"))) {
    return expr.slice(1, -1);
  }

  // Variable reference
  const varVal = vars[expr];
  if (varVal !== undefined) return String(varVal);

  // Plain string
  return expr;
}

function splitTernaryConcat(expr: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (inQuote) {
      current += ch;
      if (ch === quoteChar && expr[i - 1] !== '\\') inQuote = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === '+') {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}
