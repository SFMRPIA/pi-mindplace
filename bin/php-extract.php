<?php
/**
 * PHP-Parser based extraction for pi-mindplace.
 * Used as a fallback for files too large for tree-sitter.
 *
 * Usage: php php-extract.php <file-path> <autoload-path>
 * Output: JSON with nodes and edges
 */

if ($argc < 2) {
    echo json_encode(['error' => 'Usage: php php-extract.php <file-path> [autoload-path]']);
    exit(1);
}

$filePath = $argv[1];
if (!file_exists($filePath)) {
    echo json_encode(['error' => "File not found: $filePath"]);
    exit(1);
}

// Determine autoload path
$autoloadPaths = [
    $argv[2] ?? null,
    dirname(__DIR__, 2) . '/vendor/autoload.php',
    dirname(__DIR__) . '/vendor/autoload.php',
    // Try common Laravel project structures from pi-mindplace/bin/
    __DIR__ . '/../../../mynews/mynews-order-monitoring-backend/vendor/autoload.php',
    __DIR__ . '/../../../vendor/autoload.php',
    // Search parent directories
];

// Also search up from the file being parsed
$fileDir = dirname($filePath);
for ($i = 0; $i < 5; $i++) {
    $candidate = $fileDir . '/vendor/autoload.php';
    if (file_exists($candidate)) {
        $autoloadPaths[] = $candidate;
        break;
    }
    $fileDir = dirname($fileDir);
}

$autoload = null;
foreach ($autoloadPaths as $p) {
    if ($p && file_exists($p)) {
        $autoload = $p;
        break;
    }
}

if (!$autoload) {
    echo json_encode(['error' => 'Could not find composer autoload.php']);
    exit(1);
}

require_once $autoload;

use PhpParser\Error;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\ParserFactory;
use PhpParser\Node;

$code = file_get_contents($filePath);

$factory = new ParserFactory();
$parser = $factory->createForNewestSupportedVersion();

try {
    $ast = $parser->parse($code);
} catch (Error $e) {
    echo json_encode(['error' => 'Parse error: ' . $e->getMessage()]);
    exit(1);
}

// Process the file path for consistent node IDs (same format as tree-sitter extractor)
$relPath = $filePath;
// Try to make the path relative — check multiple common project roots
$candidates = [
    dirname($autoload, 2),  // parent of vendor/
    dirname($autoload, 3),
    dirname($autoload, 4),
];
foreach ($candidates as $root) {
    $root = str_replace('\\', '/', $root);
    $searchPath = str_replace('\\', '/', $filePath);
    if (str_starts_with($searchPath, $root . '/')) {
        $relPath = substr($searchPath, strlen($root) + 1);
        break;
    }
}

function nodeId(string $file, string $name): string {
    $clean = str_replace(['/', '\\'], '_', preg_replace('/\.[^.]+$/', '', $file));
    $safeName = preg_replace('/[^a-zA-Z0-9_$]/', '_', $name);
    return "{$clean}_{$safeName}";
}

$fileNodeId = nodeId($relPath, 'file');
$nodes = [['id' => $fileNodeId, 'label' => $relPath, 'type' => 'file', 'sourceFile' => $relPath]];
$edges = [];
$seenIds = [$fileNodeId => true];

$currentClass = null;
$currentNamespace = null;
$nsImports = []; // map alias → full name for use statements

function addNode(string $name, string $type, int $line, ?string $parentId = null): string {
    global $relPath, $nodes, $edges, $fileNodeId, $seenIds;
    $id = nodeId($relPath, $name);
    if (isset($seenIds[$id])) return $id;
    $seenIds[$id] = true;
    $nodes[] = [
        'id' => $id,
        'label' => $name,
        'type' => $type,
        'sourceFile' => $relPath,
        'sourceLocation' => "L{$line}",
    ];
    $container = $parentId ?? $fileNodeId;
    $edges[] = ['source' => $container, 'target' => $id, 'relation' => 'contains', 'confidence' => 'EXTRACTED'];
    return $id;
}

function addEdge(string $source, string $target, string $relation): void {
    global $edges;
    $edges[] = ['source' => $source, 'target' => $target, 'relation' => $relation, 'confidence' => 'EXTRACTED'];
}

// First pass: collect namespace and use statements
$traverser = new NodeTraverser();
$traverser->addVisitor(new class($relPath, $fileNodeId) extends NodeVisitorAbstract {
    private $relPath;
    private $fileNodeId;
    
    public function __construct($relPath, $fileNodeId) {
        $this->relPath = $relPath;
        $this->fileNodeId = $fileNodeId;
    }
    
    public function enterNode(Node $node) {
        global $currentNamespace, $nsImports, $nodes, $edges, $seenIds, $fileNodeId;
        
        if ($node instanceof Node\Stmt\Namespace_) {
            $name = $node->name ? implode('\\', $node->name->getParts()) : '';
            if ($name) {
                $currentNamespace = $name;
                $id = nodeId($this->relPath, $name);
                if (!isset($seenIds[$id])) {
                    $seenIds[$id] = true;
                    $nodes[] = ['id' => $id, 'label' => $name, 'type' => 'namespace', 'sourceFile' => $this->relPath];
                    $edges[] = ['source' => $this->fileNodeId, 'target' => $id, 'relation' => 'contains', 'confidence' => 'EXTRACTED'];
                }
            }
        }
        
        if ($node instanceof Node\Stmt\Use_) {
            foreach ($node->uses as $use) {
                $fullName = implode('\\', $use->name->getParts());
                $alias = $use->alias ? $use->alias->name : $use->name->getLast();
                $nsImports[$alias] = $fullName;
                
                $id = nodeId($this->relPath, $fullName);
                if (!isset($GLOBALS['seenIds'][$id])) {
                    $GLOBALS['seenIds'][$id] = true;
                    $GLOBALS['nodes'][] = ['id' => $id, 'label' => $fullName, 'type' => 'namespace', 'sourceFile' => $this->relPath];
                }
                $edges[] = ['source' => $this->fileNodeId, 'target' => $id, 'relation' => 'imports', 'confidence' => 'EXTRACTED'];
            }
        }
        
        if ($node instanceof Node\Stmt\GroupUse) {
            $prefix = implode('\\', $node->prefix->getParts());
            foreach ($node->uses as $use) {
                $fullName = $prefix . '\\' . implode('\\', $use->name->getParts());
                $alias = $use->alias ? $use->alias->name : $use->name->getLast();
                $nsImports[$alias] = $fullName;
                
                $id = nodeId($this->relPath, $fullName);
                if (!isset($GLOBALS['seenIds'][$id])) {
                    $GLOBALS['seenIds'][$id] = true;
                    $GLOBALS['nodes'][] = ['id' => $id, 'label' => $fullName, 'type' => 'namespace', 'sourceFile' => $this->relPath];
                }
                $edges[] = ['source' => $this->fileNodeId, 'target' => $id, 'relation' => 'imports', 'confidence' => 'EXTRACTED'];
            }
        }
    }
});
$traverser->traverse($ast);

// Second pass: extract classes, methods, functions, calls
$traverser2 = new NodeTraverser();
$traverser2->addVisitor(new class($relPath, $fileNodeId, $nsImports) extends NodeVisitorAbstract {
    private $relPath;
    private $fileNodeId;
    private $nsImports;
    private $currentClassId = null;
    private $currentMethodId = null;
    
    public function __construct($relPath, $fileNodeId, &$nsImports) {
        $this->relPath = $relPath;
        $this->fileNodeId = $fileNodeId;
        $this->nsImports = &$nsImports;
    }
    
    public function enterNode(Node $node) {
        // Class/interface/trait/enum
        if ($node instanceof Node\Stmt\Class_ || $node instanceof Node\Stmt\Interface_ || 
            $node instanceof Node\Stmt\Trait_ || $node instanceof Node\Stmt\Enum_) {
            $name = $node->name->name ?? 'Anonymous';
            $type = $node instanceof Node\Stmt\Interface_ ? 'interface' : 
                    ($node instanceof Node\Stmt\Trait_ ? 'trait' : 
                     ($node instanceof Node\Stmt\Enum_ ? 'enum' : 'class'));
            
            $id = addNode($name, $type, $node->getStartLine());
            $this->currentClassId = $id;
            
            // Extends
            if (isset($node->extends) && $node->extends) {
                $parentName = $node->extends instanceof Node\Name 
                    ? $node->extends->getLast() 
                    : (string)$node->extends;
                addEdge($id, nodeId($this->relPath, $parentName), 'inherits');
            }
            
            // Implements
            if (isset($node->implements)) {
                foreach ($node->implements as $iface) {
                    $ifName = $iface instanceof Node\Name ? $iface->getLast() : (string)$iface;
                    addEdge($id, nodeId($this->relPath, $ifName), 'implements');
                }
            }
        }
        
        // Method
        if ($node instanceof Node\Stmt\ClassMethod) {
            $name = $node->name->name;
            $className = '';
            $parent = $node->getAttribute('parent');
            if ($parent instanceof Node\Stmt\ClassLike && $parent->name) {
                $className = $parent->name->name;
            }
            $methodLabel = $className ? "{$className}.{$name}" : $name;
            $id = addNode($methodLabel, 'method', $node->getStartLine(), $this->currentClassId);
            $this->currentMethodId = $id;
            
            // Collect calls within this method
            $this->collectCalls($node, $id);
        }
        
        // Function
        if ($node instanceof Node\Stmt\Function_) {
            $name = $node->name->name;
            $id = addNode($name, 'function', $node->getStartLine());
            $this->currentMethodId = $id;
            $this->collectCalls($node, $id);
        }
        
        // Property
        if ($node instanceof Node\Stmt\Property) {
            foreach ($node->props as $prop) {
                addNode("\${$prop->name->name}", 'property', $prop->getStartLine(), $this->currentClassId);
            }
        }
    }
    
    private function collectCalls(Node $node, string $sourceId): void {
        // Find all function/method/static calls and new expressions
        $finder = new NodeTraverser();
        $finder->addVisitor(new class($this->relPath, $sourceId, $this->nsImports) extends NodeVisitorAbstract {
            private $relPath;
            private $sourceId;
            private $nsImports;
            
            public function __construct($relPath, $sourceId, &$nsImports) {
                $this->relPath = $relPath;
                $this->sourceId = $sourceId;
                $this->nsImports = &$nsImports;
            }
            
            public function enterNode(Node $node) {
                // Static calls: ClassName::method()
                if ($node instanceof Node\Expr\StaticCall) {
                    $name = $node->name->name ?? (string)$node->name;
                    $class = $node->class instanceof Node\Name ? $node->class->getLast() : (string)$node->class;
                    if ($name && $class !== 'parent' && $class !== 'self' && $class !== 'static') {
                        addEdge($this->sourceId, nodeId($this->relPath, $name), 'calls');
                    }
                }
                
                // Method calls: $obj->method()
                if ($node instanceof Node\Expr\MethodCall) {
                    $name = $node->name->name ?? (string)$node->name;
                    if ($name) {
                        addEdge($this->sourceId, nodeId($this->relPath, $name), 'calls');
                    }
                }
                
                // Function calls: func()
                if ($node instanceof Node\Expr\FuncCall) {
                    if ($node->name instanceof Node\Name) {
                        $name = $node->name->getLast();
                        if ($name) {
                            addEdge($this->sourceId, nodeId($this->relPath, $name), 'calls');
                        }
                    }
                }
                
                // New: new ClassName()
                if ($node instanceof Node\Expr\New_) {
                    if ($node->class instanceof Node\Name) {
                        $name = $node->class->getLast();
                        if ($name && $name !== 'static') {
                            addEdge($this->sourceId, nodeId($this->relPath, $name), 'calls');
                        }
                    }
                }
            }
        });
        $finder->traverse([$node]);
    }
    
    public function leaveNode(Node $node) {
        if ($node instanceof Node\Stmt\ClassLike) {
            $this->currentClassId = null;
        }
        if ($node instanceof Node\Stmt\ClassMethod || $node instanceof Node\Stmt\Function_) {
            $this->currentMethodId = null;
        }
    }
});
$traverser2->traverse($ast);

echo json_encode([
    'nodes' => $nodes,
    'edges' => $edges,
], JSON_UNESCAPED_SLASHES);
