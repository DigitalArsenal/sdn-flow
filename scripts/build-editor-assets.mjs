import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const editorClientRoot = path.dirname(require.resolve("@node-red/editor-client/package.json"));
const nodeRedNodesRoot = path.dirname(require.resolve("@node-red/nodes/package.json"));
const nodeRedNodesPackage = JSON.parse(
  await fs.readFile(path.join(nodeRedNodesRoot, "package.json"), "utf8"),
);

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".svg",
  ".txt",
]);

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".eot", "application/vnd.ms-fontobject"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".otf", "font/otf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const NODE_COLOR_REPLACEMENTS = new Map([
  ["#a6bbcf", "#98b8cd"],
  ["#87a980", "#7ea58d"],
  ["rgb(231, 231, 174)", "rgb(221, 229, 186)"],
  ["#d8bfd8", "#d3c6b6"],
]);

const EDITOR_CLIENT_TEXT_REPLACEMENTS = new Map([
  ["Node-RED website", "sdn-flow"],
  ["Node-RED Debug Tools", "sdn-flow Runtime Debug"],
  ["Node-RED", "sdn-flow"],
  ["Show node help", "Show node details"],
  ["Search help", "Search details"],
  ["Show help", "Show details"],
  ["No help topic selected", "No details selected"],
  ["See the Info side bar for more help", "See the Inspector sidebar for node details"],
  ["https://nodered.org/docs/telemetry", "https://github.com/DigitalArsenal/sdn-flow"],
  ["https://nodered.org/docs", "https://github.com/DigitalArsenal/sdn-flow"],
  ["https://catalogue.nodered.org/catalogue.json", ""],
]);

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walk(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(absolutePath)));
    } else {
      results.push(absolutePath);
    }
  }
  return results;
}

function getContentType(filePath) {
  return CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
}

function isTextFile(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapStringValues(value, transform) {
  if (typeof value === "string") {
    return transform(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => mapStringValues(entry, transform));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, mapStringValues(entryValue, transform)]),
    );
  }
  return value;
}

function replaceEditorClientText(source) {
  let output = source;
  for (const [before, after] of EDITOR_CLIENT_TEXT_REPLACEMENTS.entries()) {
    output = output.replaceAll(before, after);
  }
  return output;
}

function stripNodeHelpContent(source) {
  return source.replaceAll(
    /<script type="text\/html" data-help-name="[^"]+">[\s\S]*?<\/script>\s*/g,
    "",
  );
}

function sanitizeEditorClientScript(source) {
  return source
    .replaceAll('console.log("Palette editor disabled");', "")
    .replaceAll('console.log("Projects disabled");', "")
    .replaceAll('console.log("Node-RED: " + data.version);', 'console.log("sdn-flow: " + data.version);')
    .replaceAll(
      'href: RED.settings.theme("menu.menu-item-help.url","https://nodered.org/docs")',
      'href: RED.settings.theme("menu.menu-item-help.url","https://github.com/DigitalArsenal/sdn-flow")',
    )
    .replaceAll(
      "catalogues = RED.settings.theme('palette.catalogues') || ['https://catalogue.nodered.org/catalogue.json']",
      "catalogues = RED.settings.theme('palette.catalogues') || []",
    );
}

function transformEmbeddedTextAsset(route, filePath, source) {
  if (route === "/red/about") {
    return "# sdn-flow Editor\n\nCompiled flow editor for sdn-flow runtimes.\n";
  }

  if (route === "/debug/view/view.html") {
    return replaceEditorClientText(source);
  }

  if (filePath.startsWith(editorClientRoot)) {
    let output = replaceEditorClientText(source);
    if (route === "/red/red.js") {
      output = sanitizeEditorClientScript(output);
    }
    return output;
  }

  return source;
}

async function readEmbeddedAsset(route, filePath) {
  if (route === "/red/about" || isTextFile(filePath)) {
    const body = transformEmbeddedTextAsset(route, filePath, await fs.readFile(filePath, "utf8"));
    return {
      encoding: "utf8",
      body,
    };
  }
  return {
    encoding: "base64",
    body: (await fs.readFile(filePath)).toString("base64"),
  };
}

async function addAsset(embeddedAssets, route, filePath) {
  const asset = await readEmbeddedAsset(route, filePath);
  embeddedAssets[route] = {
    contentType: getContentType(filePath),
    ...asset,
  };
}

async function addDirectoryAssets(embeddedAssets, directoryPath, routePrefix = "/", filter = () => true) {
  const files = await walk(directoryPath);
  for (const filePath of files) {
    const relativePath = path.relative(directoryPath, filePath).replaceAll(path.sep, "/");
    if (!filter(relativePath)) {
      continue;
    }
    await addAsset(embeddedAssets, `${routePrefix}${relativePath}`, filePath);
  }
}

function applyNodeHtmlOverrides(source) {
  let output = source;
  for (const [before, after] of NODE_COLOR_REPLACEMENTS.entries()) {
    output = output.replaceAll(before, after);
  }
  return stripNodeHelpContent(output);
}

function parseNodeTypes(source) {
  const types = [];
  const matches = source.matchAll(/RED\.nodes\.registerType\(\s*['"]([^'"]+)['"]/g);
  for (const match of matches) {
    if (!types.includes(match[1])) {
      types.push(match[1]);
    }
  }
  return types;
}

async function buildNodeRegistry() {
  const nodeSets = [];
  const nodeConfigs = {};
  const iconFiles = await walk(path.join(nodeRedNodesRoot, "icons"));
  const iconSet = {
    module: "sdn-flow-core",
    icons: iconFiles.map((filePath) => path.basename(filePath)).sort(),
  };

  const coreRoot = path.join(nodeRedNodesRoot, "core");
  const coreFiles = (await walk(coreRoot)).filter((filePath) => {
    const relativePath = path.relative(coreRoot, filePath).replaceAll(path.sep, "/");
    return /^[^/]+\/[^/]+\.html$/.test(relativePath);
  });

  for (const filePath of coreFiles.sort()) {
    const relativePath = path.relative(coreRoot, filePath).replaceAll(path.sep, "/");
    const localePath = path.join(nodeRedNodesRoot, "locales", "en-US", relativePath);
    let source = await fs.readFile(filePath, "utf8");
    source = applyNodeHtmlOverrides(source);
    if (await pathExists(localePath)) {
      source += `\n${await fs.readFile(localePath, "utf8")}`;
    }
    source = stripNodeHelpContent(source);
    const types = parseNodeTypes(source);
    if (types.length === 0) {
      continue;
    }
    const slug = relativePath.replace(/\//g, "-").replace(/\.html$/, "");
    const id = `sdn-flow-core/${slug}`;
    nodeSets.push({
      id,
      name: slug,
      module: "sdn-flow-core",
      enabled: true,
      local: false,
      version: nodeRedNodesPackage.version,
      types,
    });
    nodeConfigs[id] = `<!-- --- [red-module:${id}] --- -->\n${source}`;
  }

  const editorLocales = {};
  for (const namespace of ["editor", "infotips", "jsonata"]) {
    const localePath = path.join(editorClientRoot, "locales", "en-US", `${namespace}.json`);
    editorLocales[namespace] = mapStringValues(
      JSON.parse(await fs.readFile(localePath, "utf8")),
      replaceEditorClientText,
    );
  }

  const nodeMessages = mapStringValues(
    JSON.parse(
      await fs.readFile(path.join(nodeRedNodesRoot, "locales", "en-US", "messages.json"), "utf8"),
    ),
    replaceEditorClientText,
  );

  return {
    editorLocales,
    nodeMessages,
    nodeSets,
    nodeConfigs,
    iconSets: [iconSet],
  };
}

async function build() {
  const embeddedAssets = {};
  await addAsset(embeddedAssets, "/", path.join(repoRoot, "docs", "node-red-index.html"));
  await addAsset(embeddedAssets, "/index.html", path.join(repoRoot, "docs", "node-red-index.html"));
  await addAsset(
    embeddedAssets,
    "/brand/sdn-flow-icon.svg",
    path.join(repoRoot, "docs", "brand", "sdn-flow-icon.svg"),
  );
  await addAsset(
    embeddedAssets,
    "/brand/sdn-flow-logo.svg",
    path.join(repoRoot, "docs", "brand", "sdn-flow-logo.svg"),
  );
  await addAsset(
    embeddedAssets,
    "/css/node-red-overrides.css",
    path.join(repoRoot, "docs", "css", "node-red-overrides.css"),
  );
  await addAsset(
    embeddedAssets,
    "/js/node-red-bootstrap.js",
    path.join(repoRoot, "docs", "js", "node-red-bootstrap.js"),
  );

  await addDirectoryAssets(
    embeddedAssets,
    path.join(editorClientRoot, "public"),
    "/",
  );

  await addDirectoryAssets(
    embeddedAssets,
    path.join(nodeRedNodesRoot, "icons"),
    "/icons/sdn-flow-core/",
  );

  await addDirectoryAssets(
    embeddedAssets,
    path.join(nodeRedNodesRoot, "icons"),
    "/icons/node-red/",
  );

  await addAsset(
    embeddedAssets,
    "/debug/view/debug-utils.js",
    path.join(nodeRedNodesRoot, "core/common/lib/debug/debug-utils.js"),
  );
  await addAsset(
    embeddedAssets,
    "/debug/view/debug.js",
    path.join(nodeRedNodesRoot, "core/common/lib/debug/debug.js"),
  );
  await addAsset(
    embeddedAssets,
    "/debug/view/view.html",
    path.join(nodeRedNodesRoot, "core/common/lib/debug/view.html"),
  );

  const registry = await buildNodeRegistry();

  const assetsOutputPath = path.join(repoRoot, "src/editor/embeddedAssets.generated.js");
  const assetsOutput =
    `// This file is generated by scripts/build-editor-assets.mjs.\n` +
    `// Do not edit by hand.\n\n` +
    `export const EmbeddedEditorAssets = ${JSON.stringify(embeddedAssets, null, 2)};\n\n` +
    `export default EmbeddedEditorAssets;\n`;
  await fs.mkdir(path.dirname(assetsOutputPath), { recursive: true });
  await fs.writeFile(assetsOutputPath, assetsOutput, "utf8");

  const registryOutputPath = path.join(repoRoot, "src/editor/nodeRedRegistry.generated.js");
  const registryOutput =
    `// This file is generated by scripts/build-editor-assets.mjs.\n` +
    `// Do not edit by hand.\n\n` +
    `export const NodeRedEditorLocales = ${JSON.stringify(registry.editorLocales, null, 2)};\n\n` +
    `export const NodeRedNodeMessages = ${JSON.stringify(registry.nodeMessages, null, 2)};\n\n` +
    `export const NodeRedNodeSets = ${JSON.stringify(registry.nodeSets, null, 2)};\n\n` +
    `export const NodeRedNodeConfigs = ${JSON.stringify(registry.nodeConfigs, null, 2)};\n\n` +
    `export const NodeRedIconSets = ${JSON.stringify(registry.iconSets, null, 2)};\n\n` +
    `export default {\n` +
    `  NodeRedEditorLocales,\n` +
    `  NodeRedNodeMessages,\n` +
    `  NodeRedNodeSets,\n` +
    `  NodeRedNodeConfigs,\n` +
    `  NodeRedIconSets,\n` +
    `};\n`;
  await fs.writeFile(registryOutputPath, registryOutput, "utf8");

  console.log(`Wrote ${path.relative(repoRoot, assetsOutputPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, registryOutputPath)}`);
}

await build();
