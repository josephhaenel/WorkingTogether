/**
 * Conservative, dependency-free symbol resolver for region-level claims.
 *
 * Maps an Edit (file source + old_string) to the enclosing NAMED symbol so two
 * agents can hold different functions in one file. Safety rule: when ANYTHING is
 * uncertain, degrade UP to whole-file ("node") grain — never claim a finer region
 * than we're sure of (a wrong-finer claim could miss a real collision).
 *
 * Determinism across peers comes from a NAME-based id (the qualified dotted path
 * of named ancestors), never a byte-offset ordinal. Brace-family languages only;
 * everything else (incl. Python for now) is node grain. A future tree-sitter
 * engine can replace `braceSymbol` behind the same `resolveTarget` signature.
 */

export interface ResolvedTarget {
  symbol: string | null; // qualified dotted path, e.g. "Foo.bar"; null => whole file
  byteRange: [number, number] | null; // advisory only (never hashed)
  grain: "node" | "region";
}

const NODE: ResolvedTarget = { symbol: null, byteRange: null, grain: "node" };
const SIZE_CAP = 1_500_000;
const MAX_AVG_LINE = 300; // crude minified/generated guard
const BRACE_EXT = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "go", "rs", "java", "cs",
  "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "swift", "kt", "scala",
]);
const KEYWORD = new Set(["if", "for", "while", "switch", "catch", "return", "function", "do", "else", "try"]);

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i >= 0 ? path.slice(i + 1).toLowerCase() : "";
}

/** Resolve a single Edit (oldString) within source to a target. */
export function resolveTarget(source: string, oldString: string, ext: string): ResolvedTarget {
  try {
    if (!BRACE_EXT.has(ext)) return NODE;
    if (source.length > SIZE_CAP || source.includes(String.fromCharCode(0))) return NODE; // large / binary
    const src = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const old = oldString.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (avgLineLength(src) > MAX_AVG_LINE) return NODE; // minified
    const first = src.indexOf(old);
    if (first < 0) return NODE; // not found (stale bytes) -> node
    if (src.indexOf(old, first + 1) >= 0) return NODE; // ambiguous match -> node
    const masked = maskStringsAndComments(src);
    const sym = braceSymbol(src, masked, first);
    if (!sym) return NODE;
    if (!isUniqueDefinition(src, masked, sym.leaf)) return NODE; // shadowed/duplicate name -> node
    return { symbol: sym.path, byteRange: sym.range, grain: "region" };
  } catch {
    return NODE;
  }
}

/** MultiEdit: region only if every edit lands in the SAME symbol, else node. */
export function resolveMultiEdit(source: string, oldStrings: string[], ext: string): ResolvedTarget {
  if (!oldStrings.length) return NODE;
  const targets = oldStrings.map((o) => resolveTarget(source, o, ext));
  if (targets.some((t) => t.grain === "node")) return NODE;
  const sym = targets[0].symbol;
  if (!targets.every((t) => t.symbol === sym)) return NODE;
  return targets[0];
}

function avgLineLength(src: string): number {
  const lines = src.split("\n");
  return src.length / Math.max(1, lines.length);
}

/** Blank out string/comment contents (preserving length + newlines) so a brace
 *  scan can't be fooled by braces inside strings or comments. */
function maskStringsAndComments(src: string): string {
  const out = src.split("");
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === "/" && c2 === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
    } else if (c === "/" && c2 === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        if (c !== "`" && src[j] === "\n") break; // unterminated single/double quote
        j++;
      }
      blank(i, j);
      i = j;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** Innermost-named enclosing symbol of `offset`, as a dotted path of named
 *  ancestors (anonymous blocks like if/for are skipped). Null => top-level/none. */
function braceSymbol(
  src: string,
  masked: string,
  offset: number
): { path: string; leaf: string; range: [number, number] } | null {
  const stack: number[] = []; // positions of currently-open '{' before offset
  for (let i = 0; i < offset && i < masked.length; i++) {
    const c = masked[i];
    if (c === "{") stack.push(i);
    else if (c === "}") stack.pop();
  }
  if (stack.length === 0) return null; // edit is at top level
  const names: string[] = [];
  let innermostNamedBrace = -1;
  for (const bracePos of stack) {
    const name = nameBeforeBrace(src, masked, bracePos);
    if (name) {
      names.push(name);
      innermostNamedBrace = bracePos;
    }
  }
  if (names.length === 0 || innermostNamedBrace < 0) return null;
  return { path: names.join("."), leaf: names[names.length - 1], range: [innermostNamedBrace, matchBrace(masked, innermostNamedBrace)] };
}

function matchBrace(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
}

/** Extract a declared name from the signature immediately preceding a '{'. */
function nameBeforeBrace(src: string, masked: string, bracePos: number): string | null {
  const from = Math.max(0, bracePos - 240);
  // use masked to find the statement boundary (so ';' in strings doesn't fool us)
  let cut = from;
  for (let i = bracePos - 1; i >= from; i--) {
    const c = masked[i];
    if (c === ";" || c === "{" || c === "}") {
      cut = i + 1;
      break;
    }
  }
  let sig = src.slice(cut, bracePos).replace(/\s+/g, " ").trim();
  if (!sig) return null;
  let m: RegExpMatchArray | null;
  if ((m = sig.match(/\b(?:function|class|interface|enum|struct|impl|trait|fn|def|namespace|module)\s+([A-Za-z_$][\w$]*)/))) {
    return m[1];
  }
  if ((m = sig.match(/\b(?:get|set)\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/))) return m[1];
  // assignment to a function/arrow:  const NAME = ... =>   |   NAME = function
  if ((m = sig.match(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)\s*$/))) {
    return m[1];
  }
  // method / function-expression:  NAME ( ... )   at the end of the signature
  if ((m = sig.match(/([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[A-Za-z_$][\w$<>.\[\] ]*)?\s*$/))) {
    if (!KEYWORD.has(m[1])) return m[1];
  }
  return null;
}

/** True if `leaf` looks like a UNIQUE definition in the file (else ambiguous). */
function isUniqueDefinition(src: string, masked: string, leaf: string): boolean {
  const esc = leaf.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `\\b(?:function|class|interface|enum|struct|impl|trait|fn|def|get|set)\\s+${esc}\\b` + // declarations
      `|\\b(?:const|let|var)\\s+${esc}\\s*=` + // const NAME = (... ) =>
      `|(?:^|[;{},(])\\s*${esc}\\s*[:=]\\s*(?:async\\s+)?(?:function|\\()` + // prop/assigned fn
      `|(?:^|[;{}])\\s*${esc}\\s*\\(`, // method shorthand
    "gm"
  );
  let count = 0;
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (++count > 1) return false;
  }
  return count === 1;
}
