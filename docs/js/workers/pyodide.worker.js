/**
 * pyodide.worker.js — Web Worker that loads Pyodide (Python → WASM runtime)
 * and exposes Python execution and pybind11 compilation capabilities.
 *
 * Protocol:
 *   postMessage({ id, method, args })
 *   → onmessage({ id, result?, error?, log? })
 *
 * Methods:
 *   init()                       — download and initialize Pyodide
 *   run({ code })                — execute Python code, return stdout + result
 *   installPackages({ packages })— install Python packages via micropip
 *   compilePybind({ source, moduleName }) — compile pybind11 C++ (requires emception)
 */

let pyodide = null;

const PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.27.0/full/";

function reply(id, result) { postMessage({ id, result }); }
function replyError(id, error) { postMessage({ id, error: String(error) }); }
function log(text, level = "info") { postMessage({ log: text, level }); }

self.onmessage = async ({ data }) => {
  const { id, method, args } = data;
  try {
    switch (method) {
      case "init": {
        log("Loading Pyodide...");
        importScripts(`${PYODIDE_CDN}pyodide.js`);
        pyodide = await loadPyodide({
          indexURL: PYODIDE_CDN,
          stdout: (text) => log(text, "info"),
          stderr: (text) => log(text, "warn"),
        });
        // Pre-install micropip for package management
        await pyodide.loadPackage("micropip");
        log("Pyodide ready (Python " + pyodide.version + ")", "success");
        reply(id, { ready: true, version: pyodide.version });
        break;
      }

      case "run": {
        if (!pyodide) throw new Error("Not initialized");
        const { code } = args;

        // Capture stdout
        let stdout = "";
        pyodide.setStdout({ batched: (text) => { stdout += text + "\n"; log(text, "info"); } });
        pyodide.setStderr({ batched: (text) => { log(text, "warn"); } });

        const result = await pyodide.runPythonAsync(code);

        // Convert Python result to JS
        let jsResult = null;
        if (result !== undefined && result !== null) {
          try { jsResult = result.toJs ? result.toJs() : result; } catch (e) { jsResult = String(result); }
        }

        reply(id, { stdout: stdout.trim(), result: jsResult });
        break;
      }

      case "installPackages": {
        if (!pyodide) throw new Error("Not initialized");
        const { packages } = args;
        log(`Installing packages: ${packages.join(", ")}...`);
        const micropip = pyodide.pyimport("micropip");
        await micropip.install(packages);
        log(`Packages installed: ${packages.join(", ")}`, "success");
        reply(id, { ok: true });
        break;
      }

      case "compilePybind": {
        if (!pyodide) throw new Error("Not initialized");
        const { source, moduleName } = args;
        // pybind11 compilation requires:
        // 1. Python headers (available in Pyodide's sysconfig)
        // 2. pybind11 headers (install via micropip)
        // 3. Compilation via emception (delegated back to main thread)
        //
        // For now, we return the compile plan — the main thread orchestrates
        // the actual emception compilation with the right include paths.

        // Get Python include path from Pyodide
        const includePath = await pyodide.runPythonAsync(`
import sysconfig
sysconfig.get_path('include')
        `);

        // Get pybind11 include path
        try {
          const micropip = pyodide.pyimport("micropip");
          await micropip.install(["pybind11"]);
        } catch (e) {
          log("pybind11 not available via micropip, using fallback headers", "warn");
        }

        let pybindInclude = null;
        try {
          pybindInclude = await pyodide.runPythonAsync(`
import pybind11
pybind11.get_include()
          `);
        } catch (e) {}

        const flags = [
          "-shared", "-fPIC", "-O2", "-std=c++17",
          `-I${includePath}`,
          ...(pybindInclude ? [`-I${pybindInclude}`] : []),
          `-DMODULE_NAME=${moduleName || "sdn_module"}`,
        ];

        reply(id, {
          compilePlan: {
            source,
            moduleName: moduleName || "sdn_module",
            lang: "c++",
            flags,
            pythonInclude: includePath,
            pybindInclude,
          },
        });
        break;
      }

      default:
        replyError(id, `Unknown method: ${method}`);
    }
  } catch (err) {
    replyError(id, err.message || String(err));
  }
};
