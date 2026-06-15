import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget, resolveMultiEdit } from "./region.js";

const sym = (src: string, old: string, ext = "ts") => resolveTarget(src, old, ext);

test("named top-level function", () => {
  const src = `export function pay(amount) {\n  const total = amount * 2;\n  return total;\n}\n`;
  const r = sym(src, "amount * 2");
  assert.equal(r.grain, "region");
  assert.equal(r.symbol, "pay");
});

test("method inside a class -> qualified path", () => {
  const src = `class Wallet {\n  charge(n) {\n    return n + 1;\n  }\n}\n`;
  assert.equal(sym(src, "n + 1").symbol, "Wallet.charge");
});

test("two different functions resolve to different symbols", () => {
  const src = `function aaa(){\n  return 1;\n}\nfunction bbb(){\n  return 2;\n}\n`;
  assert.equal(sym(src, "return 1").symbol, "aaa");
  assert.equal(sym(src, "return 2").symbol, "bbb");
});

test("const arrow function", () => {
  const src = `const handler = (req) => {\n  doThing(req);\n};\n`;
  assert.equal(sym(src, "doThing(req)").symbol, "handler");
});

test("top-level edit (imports) degrades to node", () => {
  const src = `import x from "x";\nimport y from "y";\nfunction f(){ return 1; }\n`;
  assert.equal(sym(src, 'import y from "y";').grain, "node");
});

test("braces inside a string do not fool resolution", () => {
  const src = `function pay(){\n  const s = "}";\n  return s + EDITZ;\n}\n`;
  assert.equal(sym(src, "s + EDITZ").symbol, "pay");
});

test("ambiguous old_string (multiple matches) -> node", () => {
  const src = `function a(){\n  return x;\n}\nfunction b(){\n  return x;\n}\n`;
  assert.equal(sym(src, "return x;").grain, "node");
});

test("duplicate symbol name -> node", () => {
  const src = `function dup(){\n  return 1;\n}\nfunction dup(){\n  return 2;\n}\n`;
  assert.equal(sym(src, "return 1").grain, "node");
});

test("unsupported language -> node", () => {
  const src = `def pay():\n  return 1 + EDITZ\n`;
  assert.equal(sym(src, "1 + EDITZ", "py").grain, "node");
});

test("minified -> node", () => {
  const src = "function a(){" + "x;".repeat(400) + "EDITZ}\n";
  assert.equal(sym(src, "EDITZ").grain, "node");
});

test("MultiEdit in one function -> that region; spanning two -> node", () => {
  const src = `function f(){\n  A1;\n  A2;\n}\nfunction g(){\n  B1;\n}\n`;
  assert.equal(resolveMultiEdit(src, ["A1;", "A2;"], "ts").symbol, "f");
  assert.equal(resolveMultiEdit(src, ["A1;", "B1;"], "ts").grain, "node");
});

test("determinism: same edit + same bytes -> same symbol", () => {
  const src = `function calc(){\n  return 41 + EDITZ;\n}\n`;
  assert.equal(sym(src, "41 + EDITZ").symbol, sym(src, "41 + EDITZ").symbol);
  assert.equal(sym(src, "41 + EDITZ").symbol, "calc");
});

test("CRLF source resolves the same as LF", () => {
  const lf = `function pay(){\n  return Q;\n}\n`;
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.equal(sym(crlf, "return Q;").symbol, sym(lf, "return Q;").symbol);
});
