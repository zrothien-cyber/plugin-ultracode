"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto = require("crypto");
const vm = require("vm");
const ALLOWED_WORKFLOW_IMPORTS = new Set([
    "claude",
    "claude/workflow",
    "claude/workflows",
    "@anthropic-ai/claude-code/workflow",
    "@anthropic-ai/claude-code/workflows"
]);
const WORKFLOW_BINDINGS = new Set([
    "agent",
    "spawnWorker",
    "parallel",
    "pipeline",
    "loopUntilDry",
    "adversarialVerify",
    "phase",
    "log",
    "workflow",
    "budget",
    "args",
    "context",
    "orchestrator",
    "WORKER_SCHEMA",
    "VERDICT_SCHEMA"
]);
function sourceHash(source) {
    return crypto.createHash("sha256").update(String(source || "")).digest("hex");
}
function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(",")}}`;
}
function cacheKey(parts) {
    return crypto.createHash("sha256").update(stableStringify(parts)).digest("hex");
}
function extractMetaLiteral(source) {
    const text = String(source || "");
    const match = /(?:^|\n)\s*export\s+const\s+meta\s*=\s*/m.exec(text);
    if (!match)
        return null;
    let index = match.index + match[0].length;
    while (/\s/.test(text[index]))
        index += 1;
    if (text[index] !== "{")
        return null;
    let state = "code";
    let escaped = false;
    let depth = 0;
    for (let i = index; i < text.length; i += 1) {
        const ch = text[i];
        const next = text[i + 1];
        if (state === "lineComment") {
            if (ch === "\n")
                state = "code";
            continue;
        }
        if (state === "blockComment") {
            if (ch === "*" && next === "/") {
                state = "code";
                i += 1;
            }
            continue;
        }
        if (state === "singleQuote" || state === "doubleQuote" || state === "template") {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === "\\") {
                escaped = true;
                continue;
            }
            if ((state === "singleQuote" && ch === "'") ||
                (state === "doubleQuote" && ch === '"') ||
                (state === "template" && ch === "`")) {
                state = "code";
            }
            continue;
        }
        if (ch === "/" && next === "/") {
            state = "lineComment";
            i += 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            state = "blockComment";
            i += 1;
            continue;
        }
        if (ch === "'") {
            state = "singleQuote";
            continue;
        }
        if (ch === '"') {
            state = "doubleQuote";
            continue;
        }
        if (ch === "`") {
            state = "template";
            continue;
        }
        if (ch === "{")
            depth += 1;
        if (ch === "}") {
            depth -= 1;
            if (depth === 0)
                return text.slice(index, i + 1);
        }
    }
    return null;
}
function sanitizeMeta(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const meta = {};
    for (const key of ["name", "description"]) {
        if (typeof value[key] === "string" && value[key].trim())
            meta[key] = value[key].trim();
    }
    if (Array.isArray(value.phases)) {
        meta.phases = Array.from(value.phases)
            .map((phase) => {
            if (typeof phase === "string" && phase.trim())
                return { title: phase.trim() };
            const phaseRecord = phase && typeof phase === "object" ? phase : null;
            if (phaseRecord && typeof phaseRecord.title === "string" && phaseRecord.title.trim()) {
                const out = { title: phaseRecord.title.trim() };
                for (const key of Object.keys(phaseRecord).sort()) {
                    if (key === "title")
                        continue;
                    const valueForKey = phaseRecord[key];
                    if (typeof valueForKey === "string" && valueForKey.trim())
                        out[key] = valueForKey.trim();
                    else if (typeof valueForKey === "number" || typeof valueForKey === "boolean")
                        out[key] = valueForKey;
                }
                return out;
            }
            return null;
        })
            .filter(Boolean);
    }
    return Object.keys(meta).length > 0 ? meta : null;
}
function extractClaudeWorkflowMeta(source) {
    const literal = extractMetaLiteral(source);
    if (!literal)
        return null;
    try {
        const script = new vm.Script(`(${literal})`, { timeout: 1000 });
        return sanitizeMeta(script.runInNewContext(Object.freeze({}), { timeout: 1000 }));
    }
    catch {
        return null;
    }
}
function importDeclarations(source) {
    const text = String(source || "");
    const imports = [];
    const pattern = /^\s*import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']\s*;?\s*$/gm;
    let match;
    while ((match = pattern.exec(text))) {
        imports.push({ start: match.index, end: pattern.lastIndex, module: match[1], text: match[0] });
    }
    return imports;
}
function isIdentifier(value) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(value || ""));
}
function parseNamedImportBindings(spec) {
    const trimmed = String(spec || "").trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}"))
        return null;
    const names = [];
    for (const part of trimmed.slice(1, -1).split(",")) {
        const piece = part.trim();
        if (!piece)
            continue;
        const match = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/.exec(piece);
        if (!match)
            return null;
        names.push({ imported: match[1], local: match[2] || match[1] });
    }
    return names;
}
function bindingStatementsForImport(text) {
    const trimmed = String(text || "").trim().replace(/;$/, "");
    const match = /^import\s+([\s\S]+?)\s+from\s+["'][^"']+["']$/.exec(trimmed);
    if (!match)
        return "";
    let clause = match[1].trim();
    const statements = [];
    const defaultMatch = /^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*,\s*([\s\S]+))?$/.exec(clause);
    if (defaultMatch && !clause.startsWith("{") && !clause.startsWith("*")) {
        const local = defaultMatch[1];
        if (!WORKFLOW_BINDINGS.has(local))
            statements.push(`const ${local} = orchestrator;`);
        clause = (defaultMatch[2] || "").trim();
    }
    const namespaceMatch = /^\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(clause);
    if (namespaceMatch) {
        const local = namespaceMatch[1];
        if (!WORKFLOW_BINDINGS.has(local))
            statements.push(`const ${local} = orchestrator;`);
        return statements.join("\n");
    }
    const named = parseNamedImportBindings(clause);
    if (named) {
        for (const binding of named) {
            if (!WORKFLOW_BINDINGS.has(binding.imported))
                continue;
            if (!isIdentifier(binding.local) || WORKFLOW_BINDINGS.has(binding.local))
                continue;
            statements.push(`const ${binding.local} = ${binding.imported};`);
        }
    }
    return statements.join("\n");
}
function rewriteAllowedWorkflowImports(source) {
    const text = String(source || "");
    const imports = importDeclarations(text);
    if (imports.length === 0)
        return text;
    let out = "";
    let cursor = 0;
    for (const declaration of imports) {
        out += text.slice(cursor, declaration.start);
        if (!ALLOWED_WORKFLOW_IMPORTS.has(declaration.module)) {
            out += declaration.text;
        }
        else {
            const bindings = bindingStatementsForImport(declaration.text);
            if (bindings)
                out += `${bindings}\n`;
        }
        cursor = declaration.end;
    }
    out += text.slice(cursor);
    return out;
}
function hasExportedRunFunction(source) {
    return /\bexport\s+(?:async\s+)?function\s+run\s*\(/.test(String(source || ""));
}
function prepareClaudeWorkflowSource(source) {
    const rewritten = rewriteAllowedWorkflowImports(source);
    if (!hasExportedRunFunction(rewritten))
        return rewritten;
    return `${rewritten}\nreturn await run(context);\n`;
}
function codeOnly(source) {
    const text = String(source || "");
    let out = "";
    let state = "code";
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const next = text[i + 1];
        if (state === "lineComment") {
            if (ch === "\n") {
                state = "code";
                out += "\n";
            }
            else {
                out += " ";
            }
            continue;
        }
        if (state === "blockComment") {
            if (ch === "*" && next === "/") {
                state = "code";
                out += "  ";
                i += 1;
            }
            else {
                out += ch === "\n" ? "\n" : " ";
            }
            continue;
        }
        if (state === "singleQuote" || state === "doubleQuote" || state === "template") {
            if (escaped) {
                escaped = false;
            }
            else if (ch === "\\") {
                escaped = true;
            }
            else if ((state === "singleQuote" && ch === "'") ||
                (state === "doubleQuote" && ch === '"') ||
                (state === "template" && ch === "`")) {
                state = "code";
            }
            out += ch === "\n" ? "\n" : " ";
            continue;
        }
        if (ch === "/" && next === "/") {
            state = "lineComment";
            out += "  ";
            i += 1;
            continue;
        }
        if (ch === "/" && next === "*") {
            state = "blockComment";
            out += "  ";
            i += 1;
            continue;
        }
        if (ch === "'")
            state = "singleQuote";
        else if (ch === '"')
            state = "doubleQuote";
        else if (ch === "`")
            state = "template";
        out += state === "code" ? ch : " ";
    }
    return out;
}
function unsupportedClaudeFeatures(source) {
    const text = String(source || "");
    const code = codeOnly(text);
    const unsupported = [];
    for (const declaration of importDeclarations(text)) {
        if (!ALLOWED_WORKFLOW_IMPORTS.has(declaration.module)) {
            unsupported.push(`Workflow import "${declaration.module}" is not supported; workflow scripts may only import Claude workflow primitives.`);
        }
    }
    if (/\brequire\s*\(/.test(code)) {
        unsupported.push("CommonJS require() is not available in Claude-compatible workflow scripts.");
    }
    if (/\bimport\s*\(/.test(code)) {
        unsupported.push("Dynamic import() is not available in Claude-compatible workflow scripts.");
    }
    if (/\bprocess\b/.test(code) || /\bglobalThis\s*\.\s*process\b/.test(code) || /\bglobal\s*\.\s*process\b/.test(code)) {
        unsupported.push("process is not available in Claude-compatible workflow scripts; delegate shell and environment access to agents.");
    }
    if (/\bchild_process\b/.test(code) || /\bfs\b/.test(code)) {
        unsupported.push("Direct filesystem and shell modules are not available in Claude-compatible workflow scripts.");
    }
    if (/\beval\s*\(/.test(code) || /\bFunction\s*\(/.test(code)) {
        unsupported.push("Dynamic code evaluation is not available in Claude-compatible workflow scripts.");
    }
    for (const helper of ["glob", "readFile", "writeFile", "exec", "shell", "spawn"]) {
        if (new RegExp(`\\bcontext\\s*\\.\\s*${helper}\\b`).test(code)) {
            unsupported.push(`context.${helper} is not supported because Claude workflow scripts coordinate agents but do not read files or run shell commands directly.`);
        }
    }
    return unsupported;
}
function assertClaudeWorkflowSupported(source) {
    const unsupported = unsupportedClaudeFeatures(source);
    if (unsupported.length > 0) {
        throw new Error(`Unsupported Claude workflow syntax:\n- ${unsupported.join("\n- ")}`);
    }
}
module.exports = {
    assertClaudeWorkflowSupported,
    cacheKey,
    extractClaudeWorkflowMeta,
    prepareClaudeWorkflowSource,
    rewriteAllowedWorkflowImports,
    sourceHash,
    stableStringify,
    unsupportedClaudeFeatures
};
