/**
 * Class Index — builds and maintains a map of all classes with their
 * properties (with types), methods, and imports.
 *
 * Used by resolve.ts to resolve call edges across files.
 *
 * Property types extracted from three sources:
 * 1. Native typed properties: protected GrabMartStoreService $storeService;
 * 2. PHPDoc @var annotations (fallback)
 * 3. Constructor parameter type hints (last fallback)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { KnowledgeGraph } from "./graph.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PropertyInfo {
  name: string;         // "$storeService"
  type: string | null;  // "GrabMartStoreService" (short name or FQCN)
}

export interface MethodInfo {
  name: string;         // "pauseStore"
  params: Array<{ name: string; type: string | null }>;
}

export interface ClassInfo {
  name: string;         // "GrabMartStoreService"
  file: string;
  namespce: string;     // "App\Services\GrabMart"
  properties: Map<string, PropertyInfo>;
  methods: Map<string, MethodInfo>;
  imports: Map<string, string>;  // alias → FQCN: "Log" → "Illuminate\Support\Facades\Log"
}

export interface ClassIndex {
  classes: Map<string, ClassInfo>;
  methodIndex: Map<string, string[]>;  // methodName → [className, ...]
}

// ── Regex patterns ────────────────────────────────────────────────────────────

/** Matches native typed properties: protected GrabMartStoreService $storeService */
const PROP_TYPE_RE = /(?:public|protected|private|var)\s+([\w\\]+)\s+\$(\w+)/g;

/** Matches PHPDoc @var: @var GrabMartStoreService $storeService */
const PHPDOC_PROP_RE = /@var\s+([\w\\]+)\s+\$(\w+)/g;

/** Matches constructor parameters: function __construct(Type $param, ...) */
const CTOR_PARAM_RE = /([\w\\]+)\s+\$(\w+)/g;

/** Extracts the constructor signature */
const CTOR_SIG_RE = /function\s+__construct\s*\(([^)]*)\)/s;

/** Matches in-class assignment: $this->foo = new Foo(...) */
const ASSIGN_NEW_RE = /\$this->(\w+)\s*=\s*new\s+([\w\\]+)\s*\(/g;

/** Matches Laravel container resolution: $this->foo = resolve(Foo::class) / app(Foo::class) */
const ASSIGN_RESOLVE_RE = /\$this->(\w+)\s*=\s*(?:resolve|app)\s*\(\s*([\w\\]+)::class\s*\)/g;

// ── Build index ───────────────────────────────────────────────────────────────

export function buildClassIndex(cwd: string, kg: KnowledgeGraph): ClassIndex {
  const classes = new Map<string, ClassInfo>();
  const fileClasses = new Map<string, string[]>();  // file path → class names

  // ── Pass 1: collect class nodes ──────────────────────────────────────────
  for (const [, node] of kg.nodes) {
    if (node.type === "class" && node.sourceFile) {
      const ci: ClassInfo = {
        name: node.label,
        file: node.sourceFile,
        namespce: "",
        properties: new Map(),
        methods: new Map(),
        imports: new Map(),
      };
      classes.set(node.label, ci);

      if (!fileClasses.has(node.sourceFile)) {
        fileClasses.set(node.sourceFile, []);
      }
      fileClasses.get(node.sourceFile)!.push(node.label);
    }
  }

  // ── Pass 2: collect imports from edges ───────────────────────────────────
  for (const edge of kg.edges) {
    if (edge.relation !== "imports") continue;

    const srcNode = kg.nodes.get(edge.source);
    if (!srcNode || srcNode.type !== "file") continue;

    const file = srcNode.label;
    const clses = fileClasses.get(file);
    if (!clses) continue;

    const nsNode = kg.nodes.get(edge.target);
    if (!nsNode) continue;

    // The namespace node label is the FQCN (e.g. "App\Services\GrabMart\GrabMartStoreService")
    const fqcn = nsNode.label;
    const short = fqcn.split("\\").pop() ?? fqcn;

    for (const clsName of clses) {
      const ci = classes.get(clsName);
      if (ci) ci.imports.set(short, fqcn);
    }
  }

  // ── Pass 3: collect namespace declarations ────────────────────────────────
  // Namespace nodes linked via "contains" edge from the file (not "imports")
  for (const edge of kg.edges) {
    if (edge.relation !== "contains") continue;

    const srcNode = kg.nodes.get(edge.source);
    const tgtNode = kg.nodes.get(edge.target);
    if (srcNode?.type === "file" && tgtNode?.type === "namespace") {
      const clses = fileClasses.get(srcNode.label);
      if (clses) {
        for (const clsName of clses) {
          const ci = classes.get(clsName);
          if (ci && !ci.namespce) ci.namespce = tgtNode.label;
        }
      }
    }
  }

  // ── Pass 4: collect methods from graph ────────────────────────────────────
  for (const [, node] of kg.nodes) {
    if (node.type !== "method" || !node.sourceFile) continue;
    const clses = fileClasses.get(node.sourceFile);
    if (!clses) continue;
    const ci = classes.get(clses[0]);
    if (!ci) continue;

    // Label is "ClassName.methodName"
    const dot = node.label.lastIndexOf(".");
    const methodName = dot >= 0 ? node.label.slice(dot + 1) : node.label;
    ci.methods.set(methodName, { name: methodName, params: [] });
  }

  // ── Pass 5: extract property types from source files ──────────────────────
  for (const [file, clses] of fileClasses) {
    const ci = classes.get(clses[0]);
    if (!ci) continue;

    const absPath = resolve(cwd, file);
    let source: string;
    try {
      source = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }

    // 5a: Native typed properties: protected GrabMartStoreService $storeService;
    let m: RegExpExecArray | null;
    while ((m = PROP_TYPE_RE.exec(source)) !== null) {
      ci.properties.set("$" + m[2], { name: "$" + m[2], type: m[1] });
    }

    // 5b: PHPDoc @var (fallback for properties without native types)
    while ((m = PHPDOC_PROP_RE.exec(source)) !== null) {
      const name = "$" + m[2];
      if (!ci.properties.has(name)) {
        ci.properties.set(name, { name, type: m[1] });
      }
    }

    // 5c: Constructor injection (last fallback)
    const ctorMatch = CTOR_SIG_RE.exec(source);
    if (ctorMatch) {
      while ((m = CTOR_PARAM_RE.exec(ctorMatch[1])) !== null) {
        const name = "$" + m[2];
        // Only set if we don't already have this property from native/phpdoc
        if (!ci.properties.has(name)) {
          ci.properties.set(name, { name, type: m[1] });
        }
      }
    }

    // 5d: Assignment inference (last fallback for untyped props)
    //     $this->foo = new Foo(...)  /  $this->foo = resolve(Foo::class)
    // (ponytail: file-global regex — an assignment in any method is accepted;
    //  constructor-scope it if a mis-inference ever shows up)
    const inferType = (raw: string): string => {
      let type = raw.replace(/^\\/, "");
      if (type.includes("\\")) type = type.split("\\").pop()!;
      return type;
    };
    while ((m = ASSIGN_NEW_RE.exec(source)) !== null) {
      const name = "$" + m[1];
      if (!ci.properties.has(name)) {
        ci.properties.set(name, { name, type: inferType(m[2]) });
      }
    }
    while ((m = ASSIGN_RESOLVE_RE.exec(source)) !== null) {
      const name = "$" + m[1];
      if (!ci.properties.has(name)) {
        ci.properties.set(name, { name, type: inferType(m[2]) });
      }
    }
  }

  // ── Build reverse method index ────────────────────────────────────────────
  const methodIndex = new Map<string, string[]>();
  for (const [clsName, ci] of classes) {
    for (const methodName of ci.methods.keys()) {
      if (!methodIndex.has(methodName)) methodIndex.set(methodName, []);
      methodIndex.get(methodName)!.push(clsName);
    }
  }

  return { classes, methodIndex };
}

// ── Name resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a short class name to its fully-qualified form using
 * the file's imports and namespace.
 */
export function resolveShortName(
  shortName: string,
  imports: Map<string, string>,
  currentNs: string,
): string | null {
  // 1. Check imports (use statements)
  if (imports.has(shortName)) {
    return imports.get(shortName)!;
  }
  // 2. Try current namespace + short name
  if (currentNs) {
    return currentNs + "\\" + shortName;
  }
  // 3. Best-effort: return short name as-is
  return shortName;
}

// ── Persistence ──────────────────────────────────────────────────────────────

const INDEX_FILE = "class-index.json";

function serialize(index: ClassIndex): unknown {
  return {
    classes: Array.from(index.classes.entries()).map(([k, v]) => [
      k,
      {
        name: v.name,
        file: v.file,
        namespce: v.namespce,
        properties: Array.from(v.properties.entries()),
        methods: Array.from(v.methods.entries()),
        imports: Array.from(v.imports.entries()),
      },
    ]),
    methodIndex: Array.from(index.methodIndex.entries()),
  };
}

function deserialize(data: any): ClassIndex {
  return {
    classes: new Map(
      (data.classes as [string, any][]).map(([k, v]) => [
        k,
        {
          name: v.name,
          file: v.file,
          namespce: v.namespce,
          properties: new Map(v.properties as [string, PropertyInfo][]),
          methods: new Map(v.methods as [string, MethodInfo][]),
          imports: new Map(v.imports as [string, string][]),
        },
      ]),
    ),
    methodIndex: new Map(data.methodIndex as [string, string[]][]),
  };
}

export function saveClassIndex(cwd: string, index: ClassIndex): void {
  const outDir = join(cwd, "graph-out");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, INDEX_FILE),
    JSON.stringify(serialize(index)),
    "utf-8",
  );
}

export function loadClassIndex(cwd: string): ClassIndex | null {
  const p = join(cwd, "graph-out", INDEX_FILE);
  if (!existsSync(p)) return null;
  try {
    return deserialize(JSON.parse(readFileSync(p, "utf-8")));
  } catch {
    return null;
  }
}
