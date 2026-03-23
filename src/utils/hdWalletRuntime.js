import fs from "node:fs/promises";
import path from "node:path";
import { Buffer } from "node:buffer";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

let hdWalletModulePromise = null;
let hdWalletPromise = null;

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildSdnPluginShimSource() {
  return [
    "import { Buffer } from 'node:buffer';",
    "import { manifestBase64 } from './generated/sdn_plugin_manifest.mjs';",
    "",
    "function decodeManifestBytes() {",
    "  if (typeof Buffer !== 'undefined') {",
    "    return Uint8Array.from(Buffer.from(manifestBase64, 'base64'));",
    "  }",
    "  if (typeof atob === 'function') {",
    "    const decoded = atob(manifestBase64);",
    "    const bytes = new Uint8Array(decoded.length);",
    "    for (let index = 0; index < decoded.length; index += 1) {",
    "      bytes[index] = decoded.charCodeAt(index);",
    "    }",
    "    return bytes;",
    "  }",
    "  throw new Error('Cannot decode HD wallet SDN manifest bytes in this runtime.');",
    "}",
    "",
    "const manifestBytes = decodeManifestBytes();",
    "",
    "export const SDN_PLUGIN_MANIFEST_EXPORTS = Object.freeze({",
    "  bytesSymbol: 'plugin_get_manifest_flatbuffer',",
    "  sizeSymbol: 'plugin_get_manifest_flatbuffer_size',",
    "});",
    "",
    "export function createSdnPluginContract({ wallet }) {",
    "  return {",
    "    manifest: wallet?.HD_WALLET_SDN_PLUGIN_MANIFEST ?? null,",
    "    manifestExports: SDN_PLUGIN_MANIFEST_EXPORTS,",
    "    getManifest() {",
    "      return this.manifest;",
    "    },",
    "    getManifestBytes() {",
    "      return new Uint8Array(manifestBytes);",
    "    },",
    "    withCapabilities() {",
    "      return this;",
    "    },",
    "    invoke(methodId) {",
    "      throw new Error(",
    "        `hd-wallet-wasm SDN plugin contract is unavailable in the npm package build (requested ${methodId}).`,",
    "      );",
    "    },",
    "    encrypt_fields(request) {",
    "      return this.invoke('encrypt_fields', request);",
    "    },",
    "    decrypt_fields(request) {",
    "      return this.invoke('decrypt_fields', request);",
    "    },",
    "    sign_detached(request) {",
    "      return this.invoke('sign_detached', request);",
    "    },",
    "    verify_detached(request) {",
    "      return this.invoke('verify_detached', request);",
    "    },",
    "  };",
    "}",
    "",
  ].join("\n");
}

function buildSdnPluginManifestSourceShim() {
  return [
    "export const HD_WALLET_SDN_PLUGIN_MANIFEST = Object.freeze({",
    "  pluginId: 'com.digitalarsenal.infrastructure.hd-wallet-wasm',",
    "  name: 'HD Wallet Crypto',",
    "  version: '2.0.1',",
    "  pluginFamily: 'infrastructure',",
    "});",
    "",
  ].join("\n");
}

async function ensureHdWalletCompatFiles() {
  const exportedModuleUrl = await import.meta.resolve("hd-wallet-wasm");
  const packageRoot = path.dirname(
    path.dirname(fileURLToPath(exportedModuleUrl)),
  );
  const sourceDirectory = path.join(packageRoot, "src");
  const sdnPluginPath = path.join(sourceDirectory, "sdn-plugin.mjs");
  const manifestSourcePath = path.join(
    sourceDirectory,
    "sdn-plugin-manifest-source.mjs",
  );

  if (!(await pathExists(sdnPluginPath))) {
    await fs.writeFile(sdnPluginPath, buildSdnPluginShimSource(), "utf8");
  }
  if (!(await pathExists(manifestSourcePath))) {
    await fs.writeFile(
      manifestSourcePath,
      buildSdnPluginManifestSourceShim(),
      "utf8",
    );
  }
}

function getEntropyBytes(length = 32) {
  if (
    globalThis.crypto &&
    typeof globalThis.crypto.getRandomValues === "function"
  ) {
    return globalThis.crypto.getRandomValues(new Uint8Array(length));
  }
  return Uint8Array.from(nodeRandomBytes(length));
}

export async function importHdWalletRuntimeModule() {
  if (!hdWalletModulePromise) {
    hdWalletModulePromise = (async () => {
      await ensureHdWalletCompatFiles();
      return import("hd-wallet-wasm");
    })();
  }
  return hdWalletModulePromise;
}

export async function getHdWalletRuntime() {
  if (!hdWalletPromise) {
    hdWalletPromise = (async () => {
      const module = await importHdWalletRuntimeModule();
      const init = module.default ?? module.createHDWallet;
      if (typeof init !== "function") {
        throw new Error("hd-wallet-wasm did not export an initialization function.");
      }
      const wallet = await init();
      if (typeof wallet.injectEntropy === "function") {
        try {
          wallet.injectEntropy(getEntropyBytes(32));
        } catch {
          // Some builds may already have an entropy source available.
        }
      }
      return wallet;
    })();
  }
  return hdWalletPromise;
}

export default {
  getHdWalletRuntime,
  importHdWalletRuntimeModule,
};
