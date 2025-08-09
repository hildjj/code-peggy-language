import * as peggy from "peggy";

import {
  CompletionItem,
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  DocumentSymbol,
  DocumentSymbolParams,
  InitializeResult,
  Location,
  LocationLink,
  ProposedFeatures,
  Range,
  RenameParams,
  SymbolKind,
  TextDocumentPositionParams,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  WorkspaceEdit,
  createConnection,
} from "vscode-languageserver/node";
import { Position, TextDocument } from "vscode-languageserver-textdocument";
import type { SourceNode } from "source-map-generator";
import { WatchMap } from "./watchMap";
import { debouncePromise } from "../common/debounce";

function getSession(
  ast: peggy.ast.Grammar,
  options: peggy.ParserBuildOptions,
  session: peggy.Session
): void {
  // Hack to get session information out of the compiler, even
  // if there are no errors, so no exception gets thrown.
  ast.code = session as unknown as SourceNode;
}

const ID = "peggyLanguageServer";
const AST = new WatchMap<string, any>();
const WORD_RE = /[^\s{}[\]()`~!@#%^&*+\-=|\\;:'",./<>?]+/g;
const PASSES: peggy.compiler.Stages = {
  prepare: peggy.compiler.passes.prepare,
  check: peggy.compiler.passes.check,
  // Skip most transform steps. See issue #29
  // `inferenceMatchResult` is the last one.  At this point, the function
  // names are munged, so we can't use them to filter correctly.
  transform: peggy.compiler.passes.transform.slice(-1),
  semantic: peggy.compiler.passes.semantic,
  generate: [getSession],
};

// Create a connection for the server. The connection uses
// stdin / stdout for message passing
const connection: Connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. The text document manager
// supports full document sync only
const documents = new TextDocuments(TextDocument);
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

interface PeggySettings {
  consoleInfo: boolean;
  markInfo: boolean;
  debounceMS: number;
}

const defaultSettings: PeggySettings = {
  consoleInfo: false,
  markInfo: true,
  debounceMS: 200,
};
let globalSettings: PeggySettings = defaultSettings;

// After the server has started the client sends an initilize request. The
// server receives in the passed params the rootPath of the workspace plus the
// client capabilites.
connection.onInitialize((): InitializeResult => ({
  capabilities: {
    // Tell the client that the server works in FULL text document sync mode
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {},
    definitionProvider: true,
    documentSymbolProvider: {
      label: "Peggy Rules",
    },
    referencesProvider: true,
    renameProvider: true,
  },
}));

connection.onInitialized(async () => {
  globalSettings = await connection.workspace.getConfiguration(ID);
});

function peggyLoc_to_vscodeRange(loc: peggy.LocationRange): Range {
  if (!loc) {
    throw new Error("loc is null");
  }
  return {
    start: { line: loc.start.line - 1, character: loc.start.column - 1 },
    end: { line: loc.end.line - 1, character: loc.end.column - 1 },
  };
}

function addProblemDiagnostics(
  problems: peggy.Problem[],
  diagnostics: Diagnostic[]
): void {
  for (const [sev, msg, loc, diags] of problems) {
    const severity: DiagnosticSeverity = {
      error: DiagnosticSeverity.Error,
      warning: DiagnosticSeverity.Warning,
      info: DiagnosticSeverity.Information,
    }[sev];
    if (loc) {
      if (globalSettings.markInfo || (sev !== "info")) {
        const d: Diagnostic = {
          severity,
          range: peggyLoc_to_vscodeRange(loc),
          message: msg,
          source: "peggy-language",
          relatedInformation: [],
        };
        if (diags) {
          for (const diag of diags) {
            d.relatedInformation.push({
              location: {
                uri: diag.location.source,
                range: peggyLoc_to_vscodeRange(diag.location),
              },
              message: diag.message,
            });
          }
        }
        diagnostics.push(d);
      }
    } else {
      if (globalSettings.consoleInfo) {
        connection.console.log(`${sev}: ${msg}`);
        if (diags) {
          for (const diag of diags) {
            connection.console.log(`  ${diag.message}`);
          }
        }
      }
    }
  }
}

async function validate(doc: TextDocument): Promise<void> {
  AST.delete(doc.uri); // Cancel any pending and start over.

  const diagnostics: Diagnostic[] = [];
  try {
    const ast = peggy.parser.parse(doc.getText(), {
      grammarSource: doc.uri,
      reservedWords: peggy.RESERVED_WORDS,
    });
    // Output type "source-and-map" returns ast.code, which, if there
    // were no errors, will be set to the info session by getSession().
    const session = peggy.compiler.compile(
      ast,
      PASSES,
      { grammarSource: doc.uri, output: "source-and-map" }
    ) as unknown as peggy.Session;
    addProblemDiagnostics(session.problems, diagnostics);
    AST.set(doc.uri, ast);
  } catch (error) {
    if (error instanceof peggy.GrammarError) {
      addProblemDiagnostics(error.problems, diagnostics);
    } else if (error instanceof peggy.parser.SyntaxError) {
      addProblemDiagnostics([["error", error.message, error.location, []]], diagnostics);
    } else {
      connection.console.error("UNEXPECTED ERROR");
      connection.console.error(error.toString());
      const d: Diagnostic = {
        severity: DiagnosticSeverity.Error,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        message: error.stack ?? error.message,
        source: "peggy-language",
        relatedInformation: [],
      };
      diagnostics.push(d);
    }
    AST.set(doc.uri, null);
  }

  // Send the computed diagnostics to VS Code.
  await connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

const validateTextDocument = debouncePromise(
  validate,
  globalSettings.debounceMS
);

connection.onDidChangeConfiguration(async () => {
  globalSettings = await connection.workspace.getConfiguration(ID);
  validateTextDocument.wait = globalSettings.debounceMS;

  // Revalidate all open text documents
  documents.all().forEach(validateTextDocument);
});

function getWordAtPosition(document: TextDocument, position: Position): string {
  const line = document.getText({
    start: { line: position.line, character: 0 },
    end: { line: position.line + 1, character: 0 },
  });
  for (const match of line.matchAll(WORD_RE)) {
    if ((match.index <= position.character)
        && ((match.index + match[0].length) >= position.character)) {
      return match[0];
    }
  }

  return "";
}

function ruleNameRange(name: string, ruleRange: Range): Range {
  return {
    start: ruleRange.start,
    end: {
      line: ruleRange.start.line,
      character: ruleRange.start.character + name.length,
    },
  };
}

connection.onCompletion(
  async (pos: TextDocumentPositionParams): Promise<CompletionItem[]> => {
    const docAST = await AST.waitFor(pos.textDocument.uri);
    if (!docAST || (docAST.rules.length === 0)) {
      return null;
    }
    const document = documents.get(pos.textDocument.uri);
    if (!document) {
      return null;
    }
    const word = getWordAtPosition(document, pos.position);
    if (word === "") {
      return null;
    }

    return docAST.rules.filter(
      (r: any) => r.name.startsWith(word)
    ).map((r: any) => ({
      label: r.name,
    }));
  }
);

connection.onDefinition(
  async (pos: TextDocumentPositionParams): Promise<LocationLink[]> => {
    const docAST = await AST.waitFor(pos.textDocument.uri);
    if (!docAST || (docAST.rules.length === 0)) {
      return null;
    }
    const document = documents.get(pos.textDocument.uri);
    if (!document) {
      return null;
    }
    const word = getWordAtPosition(document, pos.position);
    if (word === "") {
      return null;
    }

    const rule = docAST.rules.find((r: any) => r.name === word);
    if (!rule) {
      return null;
    }
    const targetRange = peggyLoc_to_vscodeRange(rule.location);
    const targetSelectionRange = ruleNameRange(rule.name, targetRange);

    return [
      {
        targetUri: pos.textDocument.uri,
        targetRange,
        targetSelectionRange,
      },
    ];
  }
);

connection.onReferences(
  async (pos: TextDocumentPositionParams): Promise<Location[]> => {
    const docAST = await AST.get(pos.textDocument.uri);
    if (!docAST || (docAST.rules.length === 0)) {
      return null;
    }
    const document = documents.get(pos.textDocument.uri);
    if (!document) {
      return null;
    }
    const word = getWordAtPosition(document, pos.position);
    if (word === "") {
      return null;
    }
    const results: Location[] = [];
    const visit = peggy.compiler.visitor.build({
      rule_ref(node: any): void {
        if (node.name !== word) { return; }
        results.push({
          uri: pos.textDocument.uri,
          range: peggyLoc_to_vscodeRange(node.location),
        });
      },
    });
    visit(docAST);

    return results;
  }
);

connection.onRenameRequest(
  async (pos: RenameParams): Promise<WorkspaceEdit> => {
    const docAST = await AST.get(pos.textDocument.uri);
    if (!docAST || (docAST.rules.length === 0)) {
      return null;
    }
    const document = documents.get(pos.textDocument.uri);
    if (!document) {
      return null;
    }
    const word = getWordAtPosition(document, pos.position);
    if (word === "") {
      return null;
    }

    const edits: TextEdit[] = [];
    const visit = peggy.compiler.visitor.build({
      rule_ref(node: any): void {
        if (node.name !== word) { return; }
        edits.push({
          newText: pos.newName,
          range: peggyLoc_to_vscodeRange(node.location),
        });
      },

      rule(node: any): void {
        visit(node.expression);
        if (node.name !== word) { return; }
        edits.push({
          newText: pos.newName,
          range: ruleNameRange(
            node.name,
            peggyLoc_to_vscodeRange(node.location)
          ),
        });
      },
    });
    visit(docAST);

    return {
      changes: {
        [pos.textDocument.uri]: edits,
      },
    };
  }
);

connection.onDocumentSymbol(
  async (pos: DocumentSymbolParams): Promise<DocumentSymbol[]> => {
    const docAST = await AST.waitFor(pos.textDocument.uri);
    if (!docAST) {
      return null;
    }

    const symbols = docAST.rules.map((r: any) => {
      const range = peggyLoc_to_vscodeRange(r.location);
      const ret: DocumentSymbol = {
        name: r.name,
        kind: SymbolKind.Function,
        range,
        selectionRange: ruleNameRange(r.name, range),
      };
      if (r.expression.type === "named") {
        ret.detail = r.expression.name;
      }

      return ret;
    });
    if (docAST.initializer) {
      const range = peggyLoc_to_vscodeRange(docAST.initializer.location);
      symbols.unshift({
        name: "{Per-parse initializer}",
        kind: SymbolKind.Constructor,
        range,
        selectionRange: ruleNameRange("{", range),
      });
    }
    if (docAST.topLevelInitializer) {
      const range = peggyLoc_to_vscodeRange(
        docAST.topLevelInitializer.location
      );
      symbols.unshift({
        name: "{{Global initializer}}",
        kind: SymbolKind.Constructor,
        range,
        selectionRange: ruleNameRange("{{", range),
      });
    }

    return symbols;
  }
);

documents.onDidClose(change => {
  AST.delete(change.document.uri);

  setTimeout(() => {
    connection.sendDiagnostics({
      uri: change.document.uri,
      diagnostics: [],
    });
  }, globalSettings.debounceMS);
});

documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

// Listen on the connection
connection.listen();
