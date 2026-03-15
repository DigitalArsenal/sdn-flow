/**
 * emception.worker.js — Web Worker that loads emception (in-browser C++ → WASM
 * compiler) and exposes it via a simple message-passing API.
 *
 * Protocol:
 *   postMessage({ id, method, args })
 *   → onmessage({ id, result?, error?, log? })
 *
 * Methods:
 *   init({ baseUrl })    — download and initialize emception
 *   writeFile(path, data) — write to VFS
 *   readFile(path, opts)  — read from VFS
 *   run(cmd)              — run an em++ / emcc command
 *   compile({ source, lang, flags, outputName }) — high-level compile
 */

let emception = null;

// Dynamic import of emception — baseUrl determines where .pack files live
async function loadEmception(baseUrl) {
  // Try the new ESM API first (src/emception.mjs)
  try {
    const mod = await import(new URL("src/emception.mjs", baseUrl).href);
    const Emception = mod.default || mod.Emception;
    return new Emception({ baseUrl });
  } catch (e) {
    // Fallback: try the demo-style class
    try {
      const mod = await import(new URL("demo/emception.js", baseUrl).href);
      const Emception = mod.default || mod.Emception;
      const instance = new Emception();
      return instance;
    } catch (e2) {
      throw new Error(`Failed to load emception from ${baseUrl}: ${e.message}; fallback: ${e2.message}`);
    }
  }
}

function reply(id, result) { postMessage({ id, result }); }
function replyError(id, error) { postMessage({ id, error: String(error) }); }
function log(text, level = "info") { postMessage({ log: text, level }); }

self.onmessage = async ({ data }) => {
  const { id, method, args } = data;
  try {
    switch (method) {
      case "init": {
        const baseUrl = args?.baseUrl || "../emception/";
        log(`Loading emception from ${baseUrl}...`);
        emception = await loadEmception(baseUrl);

        // Wire up output callbacks
        if (emception.onstdout !== undefined) {
          emception.onstdout = (str) => log(str, "info");
        }
        if (emception.onstderr !== undefined) {
          emception.onstderr = (str) => log(str, "warn");
        }
        if (emception.onprogress !== undefined) {
          emception.onprogress = (stage, detail) => log(`[${stage}] ${detail}`, "info");
        }

        log("Initializing emception tools (this may take a moment)...");
        await emception.init();
        log("Emception ready.", "success");
        reply(id, { ready: true });
        break;
      }

      case "writeFile": {
        if (!emception) throw new Error("Not initialized");
        const [path, data] = args;
        if (emception.writeFile) {
          emception.writeFile(path, data);
        } else if (emception.fileSystem) {
          emception.fileSystem.writeFile(path, data);
        }
        reply(id, { ok: true });
        break;
      }

      case "readFile": {
        if (!emception) throw new Error("Not initialized");
        const [path, opts] = args;
        let content;
        if (emception.readFile) {
          content = emception.readFile(path, opts);
        } else if (emception.fileSystem) {
          content = emception.fileSystem.readFile(path, opts);
        }
        reply(id, { content });
        break;
      }

      case "run": {
        if (!emception) throw new Error("Not initialized");
        log(`$ ${args.cmd}`, "cmd");
        const result = emception.run(args.cmd);
        reply(id, result);
        break;
      }

      case "compile": {
        if (!emception) throw new Error("Not initialized");
        const { source, lang, flags, outputName } = args;
        // Use high-level compile if available
        if (emception.compile) {
          const result = emception.compile(source, { lang, flags, outputName });
          reply(id, result);
        } else {
          // Manual: write source, run em++, read output
          const ext = lang === "c" ? ".c" : ".cpp";
          const compiler = lang === "c" ? "emcc" : "em++";
          const outName = outputName || "output";
          const flagStr = (flags || ["-O2"]).join(" ");

          if (emception.writeFile) {
            emception.writeFile(`/working/input${ext}`, source);
          } else if (emception.fileSystem) {
            emception.fileSystem.writeFile(`/working/input${ext}`, source);
          }

          const cmd = `${compiler} ${flagStr} -sWASM=1 -sEXPORT_ES6=1 -sSINGLE_FILE=1 input${ext} -o ${outName}.mjs`;
          log(`$ ${cmd}`, "cmd");
          const result = emception.run(cmd);

          let wasmModule = null;
          let loaderModule = null;
          if (result.returncode === 0) {
            try {
              const readFn = emception.readFile?.bind(emception) || emception.fileSystem?.readFile?.bind(emception.fileSystem);
              loaderModule = readFn(`/working/${outName}.mjs`, { encoding: "utf8" });
            } catch (e) {}
          }
          reply(id, { ...result, loaderModule });
        }
        break;
      }

      default:
        replyError(id, `Unknown method: ${method}`);
    }
  } catch (err) {
    replyError(id, err.message || String(err));
  }
};
