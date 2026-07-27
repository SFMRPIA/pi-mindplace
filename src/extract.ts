/**
 * AST extraction using tree-sitter with SHA256 caching.
 *
 * Supports: JavaScript, TypeScript, Python, Go, Bash, JSON
 * Each file is hashed — unchanged files skip re-extraction.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import Parser from "tree-sitter";
// @ts-expect-error WASM
import JavaScript from "tree-sitter-javascript";
// @ts-expect-error WASM
import TsLang from "tree-sitter-typescript/bindings/node/typescript.js";
// @ts-expect-error WASM
import TsxLang from "tree-sitter-typescript/bindings/node/tsx.js";
// @ts-expect-error WASM
import Python from "tree-sitter-python";
// @ts-expect-error WASM
import Go from "tree-sitter-go";
// @ts-expect-error WASM
import Bash from "tree-sitter-bash";
// @ts-expect-error WASM
import Json from "tree-sitter-json";
// @ts-expect-error WASM
import Java from "tree-sitter-java";
// @ts-expect-error WASM
import Rust from "tree-sitter-rust";
// @ts-expect-error WASM
import Cpp from "tree-sitter-cpp";
// @ts-expect-error WASM
import Ruby from "tree-sitter-ruby";
// @ts-expect-error WASM
import Kotlin from "tree-sitter-kotlin";
// @ts-expect-error WASM
import Scala from "tree-sitter-scala";
// @ts-expect-error WASM
import Php from "tree-sitter-php";

import type { ExtractionResult, GraphEdge, GraphNode } from "./types.ts";
import { CODE_EXTENSIONS } from "./types.ts";

const parser = new Parser();

const GRAMMARS: Record<string, { grammar: Parser.Language; exts: Set<string> }> = {
  javascript: { grammar: JavaScript as unknown as Parser.Language, exts: new Set([".js", ".mjs", ".cjs"]) },
  typescript: { grammar: TsLang as unknown as Parser.Language, exts: new Set([".ts", ".mts", ".cts"]) },
  tsx: { grammar: TsxLang as unknown as Parser.Language, exts: new Set([".tsx", ".jsx"]) },
  python: { grammar: Python as unknown as Parser.Language, exts: new Set([".py", ".pyi"]) },
  go: { grammar: Go as unknown as Parser.Language, exts: new Set([".go"]) },
  bash: { grammar: Bash as unknown as Parser.Language, exts: new Set([".sh", ".bash", ".zsh"]) },
  json: { grammar: Json as unknown as Parser.Language, exts: new Set([".json"]) },
  java: { grammar: Java as unknown as Parser.Language, exts: new Set([".java"]) },
  rust: { grammar: Rust as unknown as Parser.Language, exts: new Set([".rs"]) },
  cpp: { grammar: Cpp as unknown as Parser.Language, exts: new Set([".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]) },
  ruby: { grammar: Ruby as unknown as Parser.Language, exts: new Set([".rb"]) },
  kotlin: { grammar: Kotlin as unknown as Parser.Language, exts: new Set([".kt", ".kts"]) },
  scala: { grammar: Scala as unknown as Parser.Language, exts: new Set([".scala", ".sc"]) },
  php: { grammar: Php.php as unknown as Parser.Language, exts: new Set([".php", ".phtml"]) },
};

// ── SHA256 Cache ──────────────────────────────────────────────────────────────

function fileHash(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex").slice(0, 16);
}

interface CacheEntry {
  hash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function loadCache(cacheDir: string): Map<string, CacheEntry> {
  const cache = new Map<string, CacheEntry>();
  const cacheFile = join(cacheDir, "cache.json");
  if (!existsSync(cacheFile)) return cache;
  try {
    const data = JSON.parse(readFileSync(cacheFile, "utf-8"));
    for (const [file, entry] of Object.entries(data) as [string, CacheEntry][]) {
      cache.set(file, entry);
    }
  } catch { /* ignore corrupt cache */ }
  return cache;
}

function saveCache(cacheDir: string, cache: Map<string, CacheEntry>): void {
  mkdirSync(cacheDir, { recursive: true });
  const obj: Record<string, CacheEntry> = {};
  for (const [k, v] of cache) obj[k] = v;
  writeFileSync(join(cacheDir, "cache.json"), JSON.stringify(obj, null, 2), "utf-8");
}

// ── Node ID helpers ───────────────────────────────────────────────────────────

export function nodeId(file: string, name: string): string {
  const clean = file.replace(/[\\/]/g, "_").replace(/\.[^.]+$/, "");
  const safeName = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return `${clean}_${safeName}`;
}

function pickGrammar(file: string): Parser.Language | null {
  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".")) : "";
  for (const lang of Object.values(GRAMMARS)) {
    if (lang.exts.has(ext)) return lang.grammar;
  }
  return null;
}

// ── JS/TS Extraction ──────────────────────────────────────────────────────────

function extractJS_TS(filePath: string, source: string, root: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();

  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    const loc = `L${node.startPosition.row + 1}`;
    let description: string | undefined;
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment" && (prev.text.startsWith("/**") || prev.text.startsWith("///"))) {
      description = prev.text.replace(/^\/\*\*\s*/, "").replace(/^\/\/[!/]\s*/, "")
        .replace(/\s*\*\/$/, "").replace(/\n\s*\*\s?/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 200);
    }
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: loc, description });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(node: Parser.SyntaxNode): void {
    const t = node.type;

    if (t === "function_declaration" || t === "generator_function_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? node.descendantsOfType("identifier")[0]?.text ?? "anonymous";
      const id = addNode(name, "function", node);
      for (const call of node.descendantsOfType("call_expression")) {
        const callee = call.childForFieldName?.("function");
        if (callee) {
          edges.push({ source: id, target: nodeId(filePath, callee.text), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
        }
      }
      return;
    }

    if (t === "class_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? node.descendantsOfType("identifier")[0]?.text ?? "AnonymousClass";
      const id = addNode(name, "class", node);
      for (const hc of node.children) {
        if (hc.type === "class_heritage") {
          for (const cls of hc.descendantsOfType("identifier")) {
            edges.push({ source: id, target: nodeId(filePath, cls.text), relation: "inherits", confidence: "EXTRACTED" });
          }
        }
      }
      for (const body of node.children) {
        if (body.type === "class_body") {
          for (const mem of body.children) {
            if (mem.type === "method_definition" || mem.type === "public_field_definition") {
              const mn = mem.childForFieldName?.("name")?.text ?? "unknown";
              const mid = addNode(`${name}.${mn}`, "method", mem);
              edges.push({ source: id, target: mid, relation: "contains", confidence: "EXTRACTED" });
            }
          }
        }
      }
      return;
    }

    if (t === "variable_declaration") {
      for (const ch of node.children) {
        if (ch.type === "variable_declarator") {
          const vn = ch.childForFieldName?.("name")?.text;
          const val = ch.childForFieldName?.("value");
          if (vn && val && (val.type === "arrow_function" || val.type === "function_expression")) {
            addNode(vn, "function", node);
          } else if (vn && (node.parent?.type === "export_statement" || node.parent?.type === "program")) {
            addNode(vn, "variable", node);
          }
        }
      }
      return;
    }

    if (t === "interface_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "AnonymousInterface";
      addNode(name, "interface", node);
      return;
    }

    if (t === "type_alias_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "AnonymousType";
      addNode(name, "type", node);
      return;
    }

    if (t === "import_statement") {
      const spec = node.childForFieldName?.("source");
      if (spec) {
        const modPath = spec.text.replace(/^["']|["']$/g, "");
        if (modPath.startsWith(".")) {
          const targetFile = resolveModulePath(filePath, modPath, root);
          if (targetFile) {
            const tgtId = nodeId(targetFile, "file");
            edges.push({ source: fileNodeId, target: tgtId, relation: "imports", confidence: "EXTRACTED" });
            const clause = node.childForFieldName?.("import_clause");
            if (clause) {
              for (const ispec of clause.descendantsOfType("import_specifier")) {
                const iname = ispec.childForFieldName?.("name")?.text;
                if (iname) edges.push({ source: fileNodeId, target: nodeId(targetFile, iname), relation: "imports", confidence: "INFERRED", confidenceScore: 0.95 });
              }
            }
          }
        }
      }
      return;
    }

    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── Python Extraction ─────────────────────────────────────────────────────────

function extractPython(filePath: string, source: string, _root: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    const loc = `L${node.startPosition.row + 1}`;
    // Extract docstring
    let desc: string | undefined;
    const body = node.childForFieldName?.("body");
    if (body && body.firstChild?.type === "expression_statement") {
      const es = body.firstChild.firstChild;
      if (es?.type === "string" && (es.text.startsWith('"""') || es.text.startsWith("'''"))) {
        desc = es.text.replace(/^["']{3}|["']{3}$/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
      }
    }
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: loc, description: desc });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(node: Parser.SyntaxNode): void {
    const t = node.type;

    if (t === "function_definition") {
      const name = node.childForFieldName?.("name")?.text ?? "anonymous";
      const id = addNode(name, "function", node);
      for (const call of node.descendantsOfType("call")) {
        const callee = call.childForFieldName?.("function");
        let callName: string | null = null;
        if (callee) {
          if (callee.type === "attribute") {
            callName = callee.text;
          } else {
            callName = callee.text;
          }
        }
        if (callName) {
          edges.push({ source: id, target: nodeId(filePath, callName), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
        }
      }
      return;
    }

    if (t === "class_definition") {
      const name = node.childForFieldName?.("name")?.text ?? "AnonymousClass";
      const id = addNode(name, "class", node);
      // Inheritance
      for (const base of node.children) {
        if (base.type === "argument_list") {
          for (const arg of base.descendantsOfType("identifier")) {
            edges.push({ source: id, target: nodeId(filePath, arg.text), relation: "inherits", confidence: "EXTRACTED" });
          }
        }
      }
      return;
    }

    // Decorated functions/classes
    if (t === "decorated_definition") {
      const def = node.childForFieldName?.("definition");
      if (def) {
        const defType = def.type;
        if (defType === "function_definition") {
          const name = def.childForFieldName?.("name")?.text ?? "anonymous";
          const id = addNode(name, "function", node);
          const decorator = node.firstChild;
          if (decorator?.type === "decorator") {
            const decName = decorator.childForFieldName?.("name")?.text;
            if (decName) edges.push({ source: id, target: nodeId(filePath, decName), relation: "references", confidence: "EXTRACTED" });
          }
          return;
        }
        if (defType === "class_definition") {
          const name = def.childForFieldName?.("name")?.text ?? "AnonymousClass";
          addNode(name, "class", node);
          return;
        }
      }
    }

    if (t === "import_statement" || t === "import_from_statement") {
      const mod = node.childForFieldName?.("name") ?? node.childForFieldName?.("module_name");
      if (mod) {
        const modName = mod.text;
        // Add import edge (could be external, but still track it)
        edges.push({ source: fileNodeId, target: nodeId(filePath, modName), relation: "imports", confidence: "EXTRACTED" });
      }
      return;
    }

    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── Go Extraction ─────────────────────────────────────────────────────────────

function extractGo(filePath: string, source: string, _root: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: `L${node.startPosition.row + 1}` });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(node: Parser.SyntaxNode): void {
    const t = node.type;

    if (t === "function_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "anonymous";
      const id = addNode(name, "function", node);
      for (const call of node.descendantsOfType("call_expression")) {
        const callee = call.childForFieldName?.("function");
        if (callee) edges.push({ source: id, target: nodeId(filePath, callee.text), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
      }
      return;
    }

    if (t === "type_declaration") {
      for (const spec of node.descendantsOfType("type_spec")) {
        const name = spec.childForFieldName?.("name")?.text;
        if (name) addNode(name, spec.children.some(c => c.type === "struct_type") ? "struct" : "type", spec);
      }
      return;
    }

    if (t === "method_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "anonymous";
      const receiver = node.childForFieldName?.("receiver");
      if (receiver) {
        const recvType = receiver.descendantsOfType("type_identifier")[0]?.text ?? "";
        addNode(`${recvType}.${name}`, "method", node);
      } else {
        addNode(name, "method", node);
      }
      return;
    }

    if (t === "import_declaration") {
      for (const spec of node.descendantsOfType("import_spec")) {
        const pkg = spec.childForFieldName?.("name")?.text;
        if (pkg) edges.push({ source: fileNodeId, target: nodeId(filePath, pkg), relation: "imports", confidence: "EXTRACTED" });
      }
      return;
    }

    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── Bash Extraction ───────────────────────────────────────────────────────────

function extractBash(filePath: string, _source: string, _root: string): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);
  // Basic function detection via regex fallback (tree-sitter-bash grammar can be finicky)
  // For now: extract function names from the full source
  const funcRe = /^(?:function\s+)?(\w+)\s*\(\s*\)/gm;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(_source)) !== null) {
    const name = match[1];
    const line = _source.slice(0, match.index).split("\n").length;
    const id = nodeId(filePath, name);
    if (!seenIds.has(id)) {
      seenIds.add(id);
      nodes.push({ id, label: name, type: "function", sourceFile: filePath, sourceLocation: `L${line}` });
      edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    }
  }
  return { nodes, edges };
}

// ── JSON Extraction ───────────────────────────────────────────────────────────

function extractJson(filePath: string, source: string, _root: string): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  // Add top-level keys as nodes (useful for package.json, tsconfig, etc.)
  try {
    const obj = JSON.parse(source);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      for (const key of Object.keys(obj).slice(0, 20)) {
        const id = nodeId(filePath, key);
        nodes.push({ id, label: key, type: "field", sourceFile: filePath });
        edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
      }
    }
  } catch { /* not valid JSON, skip */ }
  return { nodes, edges };
}

// ── Generic extractor (Java, C++, Rust, Ruby, Kotlin, Scala) ───────────────

/** Node types that represent named definitions across languages */
const CALL_EXPR_TYPES = new Set(["call_expression", "method_invocation", "call"]);

function extractGeneric(filePath: string, source: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: `L${node.startPosition.row + 1}` });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(n: Parser.SyntaxNode): void {
    const t = n.type;

    // Named function/method
    if (t === "function_declaration" || t === "method_declaration" || t === "function_definition" || t === "constructor_declaration") {
      const name = n.childForFieldName?.("name")?.text ?? n.descendantsOfType("identifier")[0]?.text ?? "anonymous";
      const id = addNode(name, "function", n);
      // Find call expressions within this function
      for (const ct of CALL_EXPR_TYPES) {
        for (const call of n.descendantsOfType(ct)) {
          const callee = call.firstChild;
          if (callee && callee.type !== "(" && callee.type !== "{") {
            edges.push({ source: id, target: nodeId(filePath, callee.text), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
          }
        }
      }
      // Continue walking to find nested declarations
    }

    // Class / struct / interface / trait / object / enum
    else if (t === "class_declaration" || t === "class_definition" || t === "struct_item" ||
        t === "interface_declaration" || t === "trait_item" || t === "object_definition" ||
        t === "enum_item" || t === "enum_declaration") {
      const name = n.childForFieldName?.("name")?.text ?? n.firstChild?.text ?? "Anonymous";
      const kind = t.includes("interface") ? "interface" : t.includes("struct") ? "struct" :
                   t.includes("enum") ? "enum" : t.includes("trait") ? "trait" :
                   t.includes("object") ? "object" : "class";
      const id = addNode(name, kind, n);

      // Inheritance / extends / implements / superclass
      const INHERIT_TYPES = new Set(["superclass", "super_interfaces", "base_class_clause",
        "trait_bounds", "template", "extends_clause", "implements_clause"]);
      for (const child of n.children) {
        if (INHERIT_TYPES.has(child.type) || child.type.includes("heritage")) {
          const ID_TYPES = ["identifier", "type_identifier", "scoped_identifier", "scoped_type_identifier", "generic_type"];
          for (const idt of ID_TYPES) {
            for (const ref of child.descendantsOfType(idt)) {
              edges.push({ source: id, target: nodeId(filePath, ref.text), relation: "inherits", confidence: "EXTRACTED" });
            }
          }
        }
      }
      // Continue walking to find nested methods/classes
    }

    // Import/use/mod declarations
    else if (t === "use_declaration" || t === "import_declaration" || t === "mod_item") {
      const ID_TYPES = ["identifier", "scoped_identifier", "scoped_type_identifier"];
      for (const idt of ID_TYPES) {
        for (const nameNode of n.descendantsOfType(idt)) {
          const txt = nameNode.text;
          if (txt !== "use" && txt !== "import" && txt !== "mod" && txt !== "pub" && txt !== "crate") {
            edges.push({ source: fileNodeId, target: nodeId(filePath, txt), relation: "imports", confidence: "EXTRACTED" });
          }
        }
      }
      return;
    }

    for (const child of n.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── PHP Regex Fallback (for files too large for tree-sitter) ────────────────

function extractPhpViaSubprocess(filePath: string, absPath: string): ExtractionResult {
  const _filename = fileURLToPath(import.meta.url);
  const _dirname = dirname(_filename);
  const scriptPath = join(_dirname, "..", "bin", "php-extract.php");
  const phpBinary = "D:/laragon/bin/php/php-8.4.19-Win32-vs17-x64/php.exe";

  try {
    const stdout = execSync(
      `"${phpBinary}" "${scriptPath}" "${absPath}"`,
      { timeout: 10000, maxBuffer: 10 * 1024 * 1024, encoding: "utf-8" }
    );

    const data = JSON.parse(stdout);
    if (data.error) {
      return { nodes: [], edges: [] };
    }

    return {
      nodes: data.nodes as GraphNode[],
      edges: data.edges as GraphEdge[],
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

// ── PHP Extraction ───────────────────────────────────────────────────────────
// ── PHP Extraction ───────────────────────────────────────────────────────────// ── PHP Extraction ───────────────────────────────────────────────────────────// ── PHP Extraction ───────────────────────────────────────────────────────────

function extractPhp(filePath: string, source: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  // ── Vue Extraction ────────────────────────────────────────────────────────────

/**
 * Extract symbols from a Vue Single File Component.
 * Parses the <script> block with the JavaScript/TypeScript extractor.
 */
/** Extract description from preceding PHPDoc comment */
  function getDocBlock(node: Parser.SyntaxNode): string | undefined {
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment" && (prev.text.startsWith("/**") || prev.text.startsWith("//"))) {
      return prev.text.replace(/^\/\*\*\s*/, "").replace(/\s*\*\/$/, "")
        .replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    }
    return undefined;
  }

  function addNode(name: string, type: string, node: Parser.SyntaxNode, parentId?: string): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    const loc = `L${node.startPosition.row + 1}`;
    nodes.push({
      id, label: name, type, sourceFile: filePath, sourceLocation: loc,
      description: getDocBlock(node),
    });
    const container = parentId ?? fileNodeId;
    edges.push({ source: container, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  /** Add a calls edge for known callee pattern */
  function addCall(sourceId: string, calleeText: string): void {
    // Skip dynamic calls ($variable, $this, etc.)
    if (calleeText.startsWith("$") || calleeText === "parent" || calleeText === "self" || calleeText === "static") return;
    const targetId = nodeId(filePath, calleeText);
    edges.push({ source: sourceId, target: targetId, relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
  }

  function walk(node: Parser.SyntaxNode, context?: { currentClass?: string; currentMethod?: string }): void {
    const t = node.type;
    const ctx = context ?? {};

    // ── Namespace ──────────────────────────────────────────────────────────
    if (t === "namespace_definition") {
      const nsName = node.childForFieldName?.("name")?.children
        ?.filter((c: Parser.SyntaxNode) => c.type === "name")
        ?.map((c: Parser.SyntaxNode) => c.text).join("\\") ?? "";
      if (nsName) {
        const nsId = nodeId(filePath, nsName);
        if (!seenIds.has(nsId)) {
          seenIds.add(nsId);
          nodes.push({ id: nsId, label: nsName, type: "namespace", sourceFile: filePath });
          edges.push({ source: fileNodeId, target: nsId, relation: "contains", confidence: "EXTRACTED" });
        }
      }
      return;
    }

    // ── Namespace use (import) ──────────────────────────────────────────────
    if (t === "namespace_use_declaration") {
      const clause = node.childForFieldName?.("name") ?? node.firstNamedChild;
      if (clause) {
        // Join all name parts into the full namespace path (e.g. App\\Models\\Store)
        const nameNodes = clause.descendantsOfType("name");
        const parts = nameNodes.map((n: Parser.SyntaxNode) => n.text).filter((t: string) => t !== "function" && t !== "const");
        if (parts.length > 0) {
          const fullPath = parts.join("\\");
          edges.push({ source: fileNodeId, target: nodeId(filePath, fullPath), relation: "imports", confidence: "EXTRACTED" });
        }
      }
      return;
    }

    // ── Class declaration ───────────────────────────────────────────────────
    if (t === "class_declaration" || t === "interface_declaration" || t === "trait_declaration" || t === "enum_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "Anonymous";
      const kind = t === "interface_declaration" ? "interface" :
                   t === "trait_declaration" ? "trait" :
                   t === "enum_declaration" ? "enum" : "class";
      const classId = addNode(name, kind, node);

      // Inheritance: extends (base_clause)
      for (const child of node.children) {
        if (child.type === "base_clause") {
          for (const ref of child.descendantsOfType("name")) {
            if (ref.text !== "extends") {
              edges.push({ source: classId, target: nodeId(filePath, ref.text), relation: "inherits", confidence: "EXTRACTED" });
            }
          }
        }
        // Inheritance: implements (class_interface_clause)
        if (child.type === "class_interface_clause") {
          for (const ref of child.descendantsOfType("name")) {
            if (ref.text !== "implements") {
              edges.push({ source: classId, target: nodeId(filePath, ref.text), relation: "implements", confidence: "EXTRACTED" });
            }
          }
        }
        // Trait use inside class
        if (child.type === "use_declaration") {
          for (const ref of child.descendantsOfType("name")) {
            if (ref.text !== "use") {
              edges.push({ source: classId, target: nodeId(filePath, ref.text), relation: "references", confidence: "EXTRACTED" });
            }
          }
        }
        // Walk body to find methods and properties
        if (child.type === "declaration_list") {
          for (const bodyChild of child.children) {
            walk(bodyChild, { currentClass: name, currentMethod: undefined });
          }
        }
      }
      return;
    }

    // ── Method declaration ─────────────────────────────────────────────────
    if (t === "method_declaration") {
      const methodName = node.childForFieldName?.("name")?.text ?? "unknown";
      const fullName = ctx.currentClass ? `${ctx.currentClass}.${methodName}` : methodName;
      const methodId = addNode(fullName, "method", node);

      // Find calls within this method
      const calls = collectCalls(node);
      for (const callee of calls) {
        addCall(methodId, callee);
      }
      return;
    }

    // ── Function definition (global) ─────────────────────────────────────────
    if (t === "function_definition") {
      const funcName = node.childForFieldName?.("name")?.text ?? "anonymous";
      // Skip closures / anonymous functions
      if (funcName === "anonymous" || funcName === "{") {
        for (const child of node.children) walk(child, ctx);
        return;
      }
      const funcId = addNode(funcName, "function", node);

      const calls = collectCalls(node);
      for (const callee of calls) {
        addCall(funcId, callee);
      }
      return;
    }

    // ── Property declaration ────────────────────────────────────────────────
    if (t === "property_declaration") {
      for (const child of node.children) {
        if (child.type === "property_element") {
          const propName = child.descendantsOfType("variable_name")[0]?.text ?? "unknown";
          addNode(propName, "property", node);
        }
      }
      return;
    }

    for (const child of node.children) walk(child, ctx);
  }

  /** Collect unique callee names from a function/method body */
  function collectCalls(node: Parser.SyntaxNode): string[] {
    const callees = new Set<string>();

    // Regular function calls: some_func(...)
    // PHP: name is a direct child (type "name"), not a field — childForFieldName returns null
    for (const call of node.descendantsOfType("function_call_expression")) {
      const nameChild = call.children.find((c: Parser.SyntaxNode) => c.type === "name");
      if (nameChild) {
        const txt = nameChild.text;
        if (!txt.startsWith("\\")) callees.add(txt);
      }
    }

    // Method calls: $obj->method(...)
    // PHP: direct children are [variable_name, name(method), arguments]
    // Use direct children only — descendants would include argument names
    for (const call of node.descendantsOfType("member_call_expression")) {
      const directName = call.children.find((c: Parser.SyntaxNode) => c.type === "name" && c !== call.firstChild);
      if (directName) {
        callees.add(directName.text);
      }
    }

    // Static calls: ClassName::method(...)
    for (const call of node.descendantsOfType("scoped_call_expression")) {
      const directNames = call.children.filter((c: Parser.SyntaxNode) => c.type === "name");
      for (const n of directNames) {
        callees.add(n.text);
      }
    }

    // Object creation: new ClassName(...)
    for (const creation of node.descendantsOfType("object_creation_expression")) {
      const nameChild = creation.children.find((c: Parser.SyntaxNode) => c.type === "name");
      if (nameChild && nameChild.text !== "static") {
        callees.add(nameChild.text);
      }
    }

    return [...callees];
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── Vue Extraction ────────────────────────────────────────────────────────────

/**
 * Extract symbols from a Vue Single File Component.
 * Parses the <script> block with the JavaScript/TypeScript extractor.
 */
function extractVue(filePath: string, source: string, root: string): ExtractionResult {
  // Extract script block content
  const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/);
  if (!scriptMatch) {
    // No script block — just create a file node
    return {
      nodes: [{
        id: nodeId(filePath, "file"),
        label: filePath,
        type: "file",
        sourceFile: filePath,
      }],
      edges: [],
    };
  }

  const scriptContent = scriptMatch[1].trim();
  if (!scriptContent) {
    return {
      nodes: [{
        id: nodeId(filePath, "file"),
        label: filePath,
        type: "file",
        sourceFile: filePath,
      }],
      edges: [],
    };
  }

  // Check if TypeScript
  const isTS = /lang="ts"/.test(scriptMatch[0]);

  // Set up the JavaScript (or TypeScript) parser
  const jsParser = new Parser();
  try {
    if (isTS) {
      jsParser.setLanguage(TsLang as unknown as Parser.Language);
    } else {
      jsParser.setLanguage(JavaScript as unknown as Parser.Language);
    }
  } catch {
    return {
      nodes: [{
        id: nodeId(filePath, "file"),
        label: filePath,
        type: "file",
        sourceFile: filePath,
      }],
      edges: [],
    };
  }

  const scriptTree = jsParser.parse(scriptContent);

  // Use the JS/TS extractor on the script content — pass the original filePath for consistent IDs
  return extractJS_TS(filePath, scriptContent, root, scriptTree);
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

function extractFile(filePath: string, root: string): ExtractionResult {
  const absPath = resolve(root, filePath);
  const lang = CODE_EXTENSIONS[filePath.slice(filePath.lastIndexOf("."))] ?? "unknown";

  // Vue files: extract script block content (no tree-sitter grammar needed)
  if (lang === "vue") {
    try {
      if (statSync(absPath).size > 1_000_000) return { nodes: [], edges: [] };
    } catch {
      return { nodes: [], edges: [] };
    }
    const source = readFileSync(absPath, "utf-8");
    return extractVue(filePath, source, root);
  }

  const grammar = pickGrammar(filePath);
  if (!grammar) return { nodes: [], edges: [] };

  // Skip files larger than 1MB (e.g. package-lock.json, large data files)
  try {
    const stats = statSync(absPath);
    if (stats.size > 1_000_000) return { nodes: [], edges: [] };
  } catch {
    return { nodes: [], edges: [] };
  }

  const source = readFileSync(absPath, "utf-8");

  let tree: Parser.Tree;
  let parseFailed = false;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(source);
  } catch {
    parseFailed = true;
  }

  if (parseFailed) {
    // For PHP files that fail tree-sitter (large files), use regex fallback
    if (lang === "php") {
      return extractPhpViaSubprocess(filePath, absPath);
    }
    // For Vue files, extract script block content
    if (lang === "vue") {
      return extractVue(filePath, source, root);
    }
    return { nodes: [], edges: [] };
  }

  switch (lang) {
    case "javascript":
    case "typescript":
    case "tsx":
      return extractJS_TS(filePath, source, root, tree);
    case "python":
      return extractPython(filePath, source, root, tree);
    case "go":
      return extractGo(filePath, source, root, tree);
    case "bash":
      return extractBash(filePath, source, root);
    case "json":
      return extractJson(filePath, source, root);
    case "php":
      // Dual-pass: tree-sitter for structure (fast) + PHP-Parser for calls/imports (accurate)
      const tsResult = extractPhp(filePath, source, tree);
      const ppResult = extractPhpViaSubprocess(filePath, absPath);
      // Keep tree-sitter nodes AND PHP-Parser nodes (for call edge target resolution)
      const mergedNodes = [...tsResult.nodes];
      const seenNodeIds = new Set(tsResult.nodes.map(n => n.id));
      for (const n of ppResult.nodes) {
        if (!seenNodeIds.has(n.id)) {
          mergedNodes.push(n);
          seenNodeIds.add(n.id);
        }
      }
      // Replace call/import edges with PHP-Parser's (more accurate, includes callContext)
      const mergedEdges = [
        ...tsResult.edges.filter(e => e.relation !== "calls" && e.relation !== "imports"),
        ...ppResult.edges.filter(e => e.relation === "calls" || e.relation === "imports" || e.relation === "inherits" || e.relation === "implements"),
      ];
      return { nodes: mergedNodes, edges: mergedEdges };
    case "java":
    case "rust":
    case "cpp":
    case "ruby":
    case "kotlin":
    case "scala":
      return extractGeneric(filePath, source, tree);
    default:
      return { nodes: [], edges: [] };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a relative module path to an actual file.
 * @param fromFile The importing file (relative to root)
 * @param modPath The import path (e.g. "./auth")
 * @param root Project root for absolute file existence checks
 */
function resolveModulePath(fromFile: string, modPath: string, root: string): string | null {
  if (!modPath.startsWith(".")) return null;

  // Normalize the base directory of the importing file
  const fromDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : ".";
  // Join and clean: "src" + "./auth.ts" → "src/auth.ts"
  let resolved = fromDir === "." ? modPath.replace(/^\.\//, "") : `${fromDir}/${modPath.replace(/^\.\//, "")}`;
  // Normalize
  resolved = resolved.replace(/\/\.\//g, "/");

  // If the path already has a known extension, check directly
  const hasExt = /\.(ts|tsx|js|jsx|mts|mjs|py|go)$/.test(resolved);
  if (hasExt && existsSync(join(root, resolved))) return resolved;

  // Try known extensions
  const exts = [".ts", ".js", ".tsx", ".jsx", ".mts", ".mjs", ".py", ".go"];
  for (const ext of exts) {
    if (existsSync(join(root, resolved + ext))) return resolved + ext;
  }
  for (const ext of exts) {
    if (existsSync(join(root, `${resolved}/index${ext}`))) return `${resolved}/index${ext}`;
  }
  return null;
}

/**
 * Extract entities from code files with caching.
 * @param root Project root
 * @param files Relative file paths
 * @param cacheDir Cache directory (null = no cache)
 * @param force Ignore cache
 */
export function extract(
  root: string,
  files: string[],
  cacheDir?: string,
  force?: boolean,
  onProgress?: (done: number) => void,
): ExtractionResult & { cached: number; extracted: number } {
  const cache = cacheDir ? loadCache(cacheDir) : new Map<string, CacheEntry>();
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  let cached = 0;
  let extracted = 0;

  for (const file of files) {
    const abs = resolve(root, file);
    if (!existsSync(abs)) continue;

    const hash = fileHash(abs);

    if (!force && cache.has(file) && cache.get(file)!.hash === hash) {
      const entry = cache.get(file)!;
      for (const n of entry.nodes) {
        if (!seenIds.has(n.id)) { seenIds.add(n.id); allNodes.push(n); }
      }
      allEdges.push(...entry.edges);
      cached++;
      continue;
    }

    const result = extractFile(file, root);
    for (const n of result.nodes) {
      if (!seenIds.has(n.id)) { seenIds.add(n.id); allNodes.push(n); }
    }
    allEdges.push(...result.edges);
    cache.set(file, { hash, nodes: result.nodes, edges: result.edges });
    extracted++;
    onProgress?.(cached + extracted);
  }

  if (cacheDir) saveCache(cacheDir, cache);

  return { nodes: allNodes, edges: allEdges, cached, extracted };
}
