/**
 * Cross-file call resolver.
 *
 * Uses the ClassIndex (from class-index.ts) plus callContext metadata
 * on call edges (from PHP-Parser) to retarget call edges from bare
 * method names to fully qualified ClassName.method.
 *
 * Resolution rules:
 * - "$this" or missing context → same-class method (already correct)
 * - "$this->propName" → look up property type in class index → resolve short name → find method
 * - "ClassName" (static call) → resolve alias via imports/namespace → find method
 * - Other → leave unresolved
 */

import type { KnowledgeGraph, GraphNode } from "./types.ts";
import type { ClassIndex } from "./class-index.ts";
import { resolveShortName } from "./class-index.ts";

/**
 * Resolve all call edges in the graph.
 * Retargets edges that can be resolved, leaves others unchanged.
 * Returns the count of resolved edges.
 */
export function resolveCalls(kg: KnowledgeGraph, index: ClassIndex): number {
  let resolved = 0;

  for (const edge of kg.edges) {
    if (edge.relation !== "calls") continue;

    // Get source method node
    const srcNode = kg.nodes.get(edge.source);
    if (!srcNode || srcNode.type !== "method") continue;

    // Extract source class name from method label "GrabMartController.selfServeActivate"
    const label = srcNode.label;
    const dot = label.lastIndexOf(".");
    const srcClass = dot >= 0 ? label.slice(0, dot) : null;
    if (!srcClass) continue;

    const ci = index.classes.get(srcClass);
    if (!ci) continue;

    // Get call method name from the target node label
    const tgtNode = kg.nodes.get(edge.target);
    if (!tgtNode) continue;
    const methodName = tgtNode.label;

    // Resolve based on callContext
    const ctx = edge.callContext;
    let resolvedClass: string | null = null;

    if (!ctx) {
      // No context — can't do cross-file resolution. Leave as-is.
      continue;
    }

    if (ctx === "$this") {
      // $this->method() — same class (edge already points to this class's method)
      // No retargeting needed
      continue;
    }

    if (ctx.startsWith("$this->")) {
      // $this->propName->method() — look up property type
      const propName = "$" + ctx.slice("$this->".length);
      const propInfo = ci.properties.get(propName);
      if (propInfo && propInfo.type) {
        resolvedClass = resolveToClass(propInfo.type, ci, index);
      }
    } else if (!ctx.startsWith("$") && !ctx.startsWith("$")) {
      // Static call: ClassName::method() — ctx is the class name
      resolvedClass = resolveToClass(ctx, ci, index);
    }
    // Other contexts ($var, FuncCall, etc.) — not yet resolvable

    if (resolvedClass) {
      // Find the target method node in the graph
      const targetLabel = resolvedClass + "." + methodName;
      const methodNode = findMethodNode(kg, targetLabel);

      if (methodNode) {
        edge.target = methodNode.id;
        resolved++;
      } else {
        // Create a placeholder node for the resolved target
        // (shouldn't happen often, but handle gracefully)
        const targetFile = index.classes.get(resolvedClass)?.file ?? "";
        const newId = nodeIdFromLabel(resolvedClass, methodName);
        if (!kg.nodes.has(newId)) {
          kg.nodes.set(newId, {
            id: newId,
            label: targetLabel,
            type: "method",
            sourceFile: targetFile,
          });
          kg.adjacency.set(newId, new Set());
        }
        edge.target = newId;
        resolved++;
      }
    }
  }

  return resolved;
}

/**
 * Try to resolve a short class name to a class that exists in the index
 * and has the named method. Returns the class name or null.
 */
function resolveToClass(
  shortName: string,
  srcCi: ClassIndex["classes"] extends Map<string, infer V> ? V : never,
  index: ClassIndex,
): string | null {
  // Try direct lookup first (short name as-is)
  if (index.classes.has(shortName)) {
    return shortName;
  }

  // Try resolving through imports/namespace
  const fqcn = resolveShortName(shortName, srcCi.imports, srcCi.namespce);
  if (fqcn) {
    // Extract short name from FQCN
    const shortFromFqcn = fqcn.split("\\").pop() ?? fqcn;
    if (index.classes.has(shortFromFqcn)) {
      return shortFromFqcn;
    }
  }

  return null;
}

/** Find a method node by its label (e.g. "GrabMartStoreService.pauseStore") */
function findMethodNode(kg: KnowledgeGraph, label: string): GraphNode | undefined {
  for (const [, node] of kg.nodes) {
    if (node.type === "method" && node.label === label) {
      return node;
    }
  }
  return undefined;
}

/** Generate a stable node ID for a resolved method */
function nodeIdFromLabel(className: string, methodName: string): string {
  return (className + "." + methodName).replace(/[^a-zA-Z0-9_$.]/g, "_");
}
