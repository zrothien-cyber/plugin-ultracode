"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const EXPORTED_DECLARATIONS = new Set(["const", "let", "var", "async", "function", "class"]);
function transformSource(source) {
    const body = rewriteModuleExports(String(source == null ? "" : source));
    return `"use strict";\n${body}`;
}
function rewriteModuleExports(source) {
    const rewrites = findExportRewrites(source);
    if (rewrites.length === 0)
        return source;
    let body = "";
    let cursor = 0;
    for (const rewrite of rewrites) {
        body += source.slice(cursor, rewrite.start);
        body += rewrite.text;
        cursor = rewrite.end;
    }
    body += source.slice(cursor);
    return body;
}
function findExportRewrites(source) {
    const rewrites = [];
    let state = "code";
    let escaped = false;
    let braceDepth = 0;
    for (let i = 0; i < source.length; i += 1) {
        const ch = source[i];
        const next = source[i + 1];
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
        if (ch === "{") {
            braceDepth += 1;
            continue;
        }
        if (ch === "}") {
            braceDepth = Math.max(0, braceDepth - 1);
            continue;
        }
        if (braceDepth === 0 && isLinePrefixWhitespace(source, i) && startsKeyword(source, i, "export")) {
            const rewrite = exportRewriteAt(source, i);
            if (rewrite) {
                rewrites.push(rewrite);
                i = rewrite.scanEnd - 1;
            }
        }
    }
    return rewrites;
}
function exportRewriteAt(source, index) {
    const afterExport = index + "export".length;
    const tokenStart = skipWhitespace(source, afterExport);
    if (startsKeyword(source, tokenStart, "default")) {
        const afterDefault = skipWhitespace(source, tokenStart + "default".length);
        return {
            start: index,
            end: afterDefault,
            text: "return ",
            scanEnd: afterDefault
        };
    }
    const declaration = readIdentifier(source, tokenStart);
    if (EXPORTED_DECLARATIONS.has(declaration.value)) {
        return {
            start: index,
            end: tokenStart,
            text: "",
            scanEnd: tokenStart
        };
    }
    return null;
}
function isLinePrefixWhitespace(source, index) {
    for (let i = index - 1; i >= 0; i -= 1) {
        const ch = source[i];
        if (ch === "\n" || ch === "\r")
            return true;
        if (ch !== " " && ch !== "\t")
            return false;
    }
    return true;
}
function skipWhitespace(source, index) {
    let i = index;
    while (i < source.length && /\s/.test(source[i]))
        i += 1;
    return i;
}
function readIdentifier(source, index) {
    let i = index;
    while (i < source.length && isIdentifierPart(source[i]))
        i += 1;
    return { value: source.slice(index, i), end: i };
}
function startsKeyword(source, index, keyword) {
    if (!source.startsWith(keyword, index))
        return false;
    return !isIdentifierPart(source[index - 1]) && !isIdentifierPart(source[index + keyword.length]);
}
function isIdentifierPart(ch) {
    return typeof ch === "string" && /[A-Za-z0-9_$]/.test(ch);
}
module.exports = { transformSource };
