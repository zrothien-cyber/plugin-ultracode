"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { extractClaudeWorkflowMeta, sourceHash, unsupportedClaudeFeatures } = require("./claude-workflow-compat");
function codexHome() {
    if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim())
        return process.env.CODEX_HOME.trim();
    return path.join(os.homedir(), ".codex");
}
function slugForWorkflowName(name) {
    const slug = String(name || "")
        .trim()
        .replace(/\.workflow\.js$|\.js$/i, "")
        .replace(/[^A-Za-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();
    if (!slug)
        throw new Error("workflow name must contain at least one letter or number.");
    return slug.slice(0, 80);
}
function workflowSearchDirs(input = {}) {
    const cwd = path.resolve(input.cwd || process.cwd());
    const home = input.home || os.homedir();
    const codeHome = input.codex_home || codexHome();
    return [
        { scope: "project", dir: path.join(cwd, ".claude", "workflows") },
        { scope: "user", dir: path.join(home, ".claude", "workflows") },
        { scope: "codex", dir: path.join(codeHome, "ultracode", "workflows") }
    ];
}
function scopeDir(scope, input = {}) {
    const cwd = path.resolve(input.cwd || process.cwd());
    if (scope === "user")
        return path.join(input.home || os.homedir(), ".claude", "workflows");
    if (scope === "codex")
        return path.join(input.codex_home || codexHome(), "ultracode", "workflows");
    return path.join(cwd, ".claude", "workflows");
}
function definitionSummary(filePath, scope, source) {
    const meta = extractClaudeWorkflowMeta(source);
    const id = slugForWorkflowName(path.basename(filePath));
    return {
        id,
        name: (meta && meta.name) || id,
        description: (meta && meta.description) || null,
        phases: (meta && meta.phases) || [],
        scope,
        path: filePath,
        source_hash: sourceHash(source),
        unsupported: unsupportedClaudeFeatures(source)
    };
}
async function readDefinitionFile(filePath, scope) {
    const source = await fs.readFile(filePath, "utf8");
    return { ...definitionSummary(filePath, scope, source), source };
}
async function listWorkflowDefinitions(input = {}) {
    const found = [];
    const seen = new Set();
    for (const { scope, dir } of workflowSearchDirs(input)) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        const files = entries
            .filter((entry) => entry.isFile() && /\.js$/i.test(entry.name))
            .map((entry) => path.join(dir, entry.name))
            .sort();
        for (const file of files) {
            const definition = await readDefinitionFile(file, scope);
            if (seen.has(definition.id))
                continue;
            seen.add(definition.id);
            const { source, ...summary } = definition;
            found.push(summary);
        }
    }
    return found;
}
async function resolveWorkflowDefinition(identifier, input = {}) {
    if (typeof identifier !== "string" || !identifier.trim()) {
        throw new Error("workflow identifier is required.");
    }
    const raw = identifier.trim();
    if (/[\\/]/.test(raw) || /\.js$/i.test(raw)) {
        const filePath = path.resolve(input.cwd || process.cwd(), raw);
        return readDefinitionFile(filePath, "path");
    }
    const slug = slugForWorkflowName(raw);
    for (const { scope, dir } of workflowSearchDirs(input)) {
        const candidates = [path.join(dir, `${slug}.js`), path.join(dir, `${slug}.workflow.js`)];
        for (const candidate of candidates) {
            try {
                return await readDefinitionFile(candidate, scope);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
    }
    const definitions = await listWorkflowDefinitions(input);
    const match = definitions.find((definition) => definition.id === slug || slugForWorkflowName(definition.name) === slug);
    if (match)
        return readDefinitionFile(match.path, match.scope);
    throw new Error(`Workflow "${raw}" was not found in .claude/workflows, ~/.claude/workflows, or CODEX_HOME/ultracode/workflows.`);
}
async function saveWorkflowDefinition(input = {}) {
    const name = input.name || (input.meta && input.meta.name);
    const slug = slugForWorkflowName(name);
    const scope = input.scope || "project";
    const baseDir = scopeDir(scope, input);
    const filePath = path.join(baseDir, `${slug}.js`);
    const source = String(input.source || "");
    if (!source.trim())
        throw new Error("workflow source is required.");
    await fs.mkdir(baseDir, { recursive: true });
    await fs.writeFile(filePath, source.endsWith("\n") ? source : `${source}\n`, "utf8");
    return readDefinitionFile(filePath, scope);
}
async function updateWorkflowDefinition(identifier, input = {}) {
    const current = await resolveWorkflowDefinition(identifier, input);
    if (current.scope === "path") {
        throw new Error("Path-based workflow definitions cannot be updated through the definition library.");
    }
    const source = String(input.source || "");
    if (!source.trim())
        throw new Error("workflow source is required.");
    await fs.writeFile(current.path, source.endsWith("\n") ? source : `${source}\n`, "utf8");
    return readDefinitionFile(current.path, current.scope);
}
async function deleteWorkflowDefinition(identifier, input = {}) {
    const current = await resolveWorkflowDefinition(identifier, input);
    if (current.scope === "path") {
        throw new Error("Path-based workflow definitions cannot be deleted through the definition library.");
    }
    await fs.rm(current.path, { force: true });
    const { source, ...summary } = current;
    return summary;
}
module.exports = {
    codexHome,
    deleteWorkflowDefinition,
    listWorkflowDefinitions,
    resolveWorkflowDefinition,
    saveWorkflowDefinition,
    slugForWorkflowName,
    updateWorkflowDefinition,
    workflowSearchDirs
};
