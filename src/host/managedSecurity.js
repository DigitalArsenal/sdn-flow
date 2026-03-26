import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";

import {
  getHdWalletRuntime,
  importHdWalletRuntimeModule,
} from "../utils/hdWalletRuntime.js";

const DEFAULT_STORAGE_DIRNAME = ".sdn-flow";
const DEFAULT_TLS_CERTIFICATE_DAYS = 365;
const DEFAULT_TLS_ORGANIZATION = "sdn-flow";
const DEFAULT_TLS_COUNTRY = "US";

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function normalizeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIndex(value, fallback = "0") {
  return String(value ?? fallback).trim() || fallback;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJsonCompatibleValue(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON normalization.
    }
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

function compareJsonValues(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(targetPath) {
  const text = await fs.readFile(targetPath, "utf8");
  return JSON.parse(text);
}

async function ensurePrivateDirectory(targetPath) {
  await fs.mkdir(targetPath, {
    recursive: true,
    mode: 0o700,
  });
  try {
    await fs.chmod(targetPath, 0o700);
  } catch {
    // Ignore chmod failures on platforms that do not support POSIX permissions.
  }
}

async function writeSecureFile(targetPath, value, mode = 0o600) {
  await ensurePrivateDirectory(path.dirname(targetPath));
  await fs.writeFile(targetPath, value, {
    encoding: "utf8",
    mode,
  });
  try {
    await fs.chmod(targetPath, mode);
  } catch {
    // Ignore chmod failures on platforms that do not support POSIX permissions.
  }
  return targetPath;
}

async function writeSecureJsonFile(targetPath, value, mode = 0o600) {
  return writeSecureFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, mode);
}

function isWildcardHost(value) {
  const normalized = normalizeString(value, "");
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]" || normalized === "*";
}

function escapeDistinguishedNameValue(value) {
  return String(value ?? "").replace(/[\\,+=<>#;"]/g, "\\$&");
}

function normalizeOpenSslConfigValue(value) {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .trim();
}

function normalizeTimestamp(value) {
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function buildKeyFingerprint(hexValue) {
  const normalized = normalizeString(hexValue, "").toUpperCase();
  if (normalized.length <= 24) {
    return normalized || null;
  }
  return `${normalized.slice(0, 12)}:${normalized.slice(-12)}`;
}

function buildSerialHex(length = 16) {
  return Buffer.from(randomBytes(length)).toString("hex").toUpperCase();
}

function parseSubjectAltNameEntries(value) {
  const dnsNames = [];
  const ipAddresses = [];
  const entries = String(value ?? "")
    .split(/,(?=\s*(?:DNS:|IP Address:))/)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    if (entry.startsWith("DNS:")) {
      dnsNames.push(entry.slice(4));
      continue;
    }
    if (entry.startsWith("IP Address:")) {
      ipAddresses.push(entry.slice("IP Address:".length));
    }
  }

  return {
    dnsNames,
    ipAddresses,
  };
}

function parseCertificateRecord(certificatePem) {
  const certificate = new X509Certificate(certificatePem);
  const altNames = parseSubjectAltNameEntries(certificate.subjectAltName);
  return {
    subjectDn: certificate.subject,
    dnsNames: altNames.dnsNames,
    ipAddresses: altNames.ipAddresses,
    notBefore: certificate.validFrom,
    notAfter: certificate.validTo,
    isCa: certificate.ca === true,
  };
}

export function normalizeStartupProtocol(value, fallback = "http") {
  const normalized = (normalizeString(value, fallback) ?? fallback).toLowerCase();
  return normalized === "https" ? "https" : "http";
}

export function getDefaultManagedSecurityStorageDir() {
  const homeDirectory = normalizeString(
    typeof os.homedir === "function" ? os.homedir() : null,
    null,
  );
  if (homeDirectory) {
    return path.join(homeDirectory, DEFAULT_STORAGE_DIRNAME);
  }
  return path.resolve(process.cwd(), DEFAULT_STORAGE_DIRNAME);
}

function resolveStorageDir(value, fallback, projectRoot = process.cwd()) {
  const normalized = normalizeString(value, null);
  if (!normalized) {
    return path.resolve(fallback);
  }
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(projectRoot, normalized);
}

export function normalizeManagedSecuritySettings(value = {}, options = {}) {
  const fallback = isPlainObject(options.fallback) ? options.fallback : {};
  const projectRoot = normalizeString(options.projectRoot, null) ?? process.cwd();
  const fallbackStorageDir = resolveStorageDir(
    fallback.storageDir,
    getDefaultManagedSecurityStorageDir(),
    projectRoot,
  );
  const walletSource = isPlainObject(value.wallet) ? value.wallet : {};
  const walletFallback = isPlainObject(fallback.wallet) ? fallback.wallet : {};
  const tlsSource = isPlainObject(value.tls) ? value.tls : {};
  const tlsFallback = isPlainObject(fallback.tls) ? fallback.tls : {};

  return {
    storageDir: resolveStorageDir(value.storageDir, fallbackStorageDir, projectRoot),
    wallet: {
      enabled: normalizeBoolean(walletSource.enabled, normalizeBoolean(walletFallback.enabled, false)),
      coinType: normalizeInteger(walletSource.coinType, normalizeInteger(walletFallback.coinType, 0)),
      account: normalizeIndex(walletSource.account, walletFallback.account ?? "0"),
      signingIndex: normalizeIndex(walletSource.signingIndex, walletFallback.signingIndex ?? "0"),
      encryptionIndex: normalizeIndex(
        walletSource.encryptionIndex,
        walletFallback.encryptionIndex ?? "0",
      ),
    },
    tls: {
      enabled: normalizeBoolean(tlsSource.enabled, normalizeBoolean(tlsFallback.enabled, false)),
      certificateDays: Math.max(
        1,
        normalizeInteger(
          tlsSource.certificateDays,
          normalizeInteger(tlsFallback.certificateDays, DEFAULT_TLS_CERTIFICATE_DAYS),
        ),
      ),
      organization:
        normalizeString(
          tlsSource.organization,
          tlsFallback.organization ?? DEFAULT_TLS_ORGANIZATION,
        ) ?? DEFAULT_TLS_ORGANIZATION,
      country:
        normalizeString(tlsSource.country, tlsFallback.country ?? DEFAULT_TLS_COUNTRY) ??
        DEFAULT_TLS_COUNTRY,
    },
  };
}

export function createDefaultEditorManagedSecuritySettings(options = {}) {
  return normalizeManagedSecuritySettings(
    {},
    {
      ...options,
      fallback: {
        wallet: {
          enabled: true,
        },
        tls: {
          enabled: false,
        },
      },
    },
  );
}

function sanitizeScopeId(value, fallback = "default") {
  const normalized = String(value ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function getManagedSecurityPaths(options = {}) {
  const projectRoot = normalizeString(options.projectRoot, null) ?? process.cwd();
  const storageDir = resolveStorageDir(
    options.storageDir,
    getDefaultManagedSecurityStorageDir(),
    projectRoot,
  );
  const scopeId = sanitizeScopeId(options.scopeId, "default");
  const scopeDir = path.join(storageDir, "managed", scopeId);
  const tlsDir = path.join(scopeDir, "tls");
  return {
    storageDir,
    scopeId,
    scopeDir,
    walletRecordPath: path.join(scopeDir, "wallet.json"),
    tlsDir,
    tlsMetadataPath: path.join(tlsDir, "server.json"),
    certificatePath: path.join(tlsDir, "server-cert.pem"),
    privateKeyPath: path.join(tlsDir, "server-key.pem"),
  };
}

function buildCertificateNames(startup = {}) {
  const hostname = normalizeString(startup.hostname, "127.0.0.1") ?? "127.0.0.1";
  const dnsNames = new Set(["localhost"]);
  const ipAddresses = new Set(["127.0.0.1"]);

  if (!isWildcardHost(hostname)) {
    const normalizedHost = hostname.replace(/^\[(.*)\]$/, "$1");
    if (net.isIP(normalizedHost)) {
      ipAddresses.add(normalizedHost);
    } else {
      dnsNames.add(normalizedHost);
    }
  }

  const dnsNameList = Array.from(dnsNames).sort();
  const ipAddressList = Array.from(ipAddresses).sort();
  return {
    commonName: dnsNameList[0] ?? ipAddressList[0] ?? "localhost",
    dnsNames: dnsNameList,
    ipAddresses: ipAddressList,
  };
}

function buildSubjectDn(commonName, tlsSettings = {}) {
  const cn = escapeDistinguishedNameValue(commonName);
  const organization = escapeDistinguishedNameValue(
    normalizeString(tlsSettings.organization, DEFAULT_TLS_ORGANIZATION) ?? DEFAULT_TLS_ORGANIZATION,
  );
  const country = escapeDistinguishedNameValue(
    normalizeString(tlsSettings.country, DEFAULT_TLS_COUNTRY) ?? DEFAULT_TLS_COUNTRY,
  );
  return `CN=${cn},O=${organization},C=${country}`;
}

function buildOpenSslConfig(commonName, desiredNames, tlsSettings = {}) {
  const organization =
    normalizeOpenSslConfigValue(
      normalizeString(tlsSettings.organization, DEFAULT_TLS_ORGANIZATION) ??
        DEFAULT_TLS_ORGANIZATION,
    ) || DEFAULT_TLS_ORGANIZATION;
  const country =
    normalizeOpenSslConfigValue(
      normalizeString(tlsSettings.country, DEFAULT_TLS_COUNTRY) ??
        DEFAULT_TLS_COUNTRY,
    ) || DEFAULT_TLS_COUNTRY;
  const normalizedCommonName =
    normalizeOpenSslConfigValue(commonName) || "localhost";
  const altNameLines = [];
  let altIndex = 1;

  for (const dnsName of desiredNames.dnsNames) {
    altNameLines.push(
      `DNS.${altIndex} = ${normalizeOpenSslConfigValue(dnsName)}`,
    );
    altIndex += 1;
  }
  altIndex = 1;
  for (const ipAddress of desiredNames.ipAddresses) {
    altNameLines.push(
      `IP.${altIndex} = ${normalizeOpenSslConfigValue(ipAddress)}`,
    );
    altIndex += 1;
  }

  return [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    "x509_extensions = ext",
    "",
    "[dn]",
    `CN = ${normalizedCommonName}`,
    `O = ${organization}`,
    `C = ${country}`,
    "",
    "[ext]",
    "basicConstraints = critical,CA:true",
    "keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign,cRLSign",
    "extendedKeyUsage = serverAuth",
    "subjectAltName = @alt_names",
    "",
    "[alt_names]",
    ...altNameLines,
    "",
  ].join("\n");
}

function certificateCoversNames(parsedCertificate = {}, desiredNames = {}) {
  const availableDns = new Set(
    Array.isArray(parsedCertificate.dnsNames)
      ? parsedCertificate.dnsNames.map((value) => String(value))
      : [],
  );
  const availableIps = new Set(
    Array.isArray(parsedCertificate.ipAddresses)
      ? parsedCertificate.ipAddresses.map((value) => String(value))
      : [],
  );
  return (
    desiredNames.dnsNames.every((value) => availableDns.has(value)) &&
    desiredNames.ipAddresses.every((value) => availableIps.has(value))
  );
}

function certificateIsCurrentlyValid(parsedCertificate = {}) {
  const now = Date.now();
  const notBefore = normalizeTimestamp(parsedCertificate.notBefore);
  const notAfter = normalizeTimestamp(parsedCertificate.notAfter);
  return (
    (notBefore === null || notBefore <= now + 60_000) &&
    (notAfter === null || notAfter > now + 60_000)
  );
}

function normalizeWalletPublicState(record = {}) {
  return {
    enabled: true,
    recordPath: record.recordPath,
    createdAt: record.createdAt,
    label: record.label,
    mnemonicWordCount: record.mnemonicWordCount,
    coinType: record.coinType,
    account: record.account,
    signingIndex: record.signingIndex,
    encryptionIndex: record.encryptionIndex,
    signingPath: record.signingPath,
    encryptionPath: record.encryptionPath,
    signingPublicKeyHex: record.signingPublicKeyHex,
    encryptionPublicKeyHex: record.encryptionPublicKeyHex,
    signingFingerprint: record.signingFingerprint,
    encryptionFingerprint: record.encryptionFingerprint,
  };
}

function normalizeTlsPublicState(record = {}) {
  return {
    enabled: true,
    createdAt: record.createdAt,
    subjectDn: record.subjectDn,
    dnsNames: Array.isArray(record.dnsNames) ? [...record.dnsNames] : [],
    ipAddresses: Array.isArray(record.ipAddresses) ? [...record.ipAddresses] : [],
    certificatePath: record.certificatePath,
    privateKeyPath: record.privateKeyPath,
    trustCertificatePath: record.trustCertificatePath,
    metadataPath: record.metadataPath,
    walletAttested: record.walletAttested !== false,
    reused: record.reused === true,
  };
}

async function ensureManagedWalletState(options = {}) {
  const wallet = options.wallet;
  const runtimeModule = options.runtimeModule;
  const paths = options.paths;
  const securitySettings = options.securitySettings;
  const scopeLabel = normalizeString(options.scopeLabel, "sdn-flow managed wallet") ??
    "sdn-flow managed wallet";

  await ensurePrivateDirectory(path.dirname(paths.walletRecordPath));
  const currentRecord =
    (await pathExists(paths.walletRecordPath))
      ? await readJsonFile(paths.walletRecordPath)
      : null;
  const currentMnemonic = normalizeString(currentRecord?.mnemonic, null);
  const mnemonic =
    currentMnemonic && wallet.mnemonic.validate(currentMnemonic)
      ? currentMnemonic
      : wallet.mnemonic.generate(24);
  const seed = wallet.mnemonic.toSeed(mnemonic, "");
  const hdRoot = wallet.hdkey.fromSeed(seed);
  let signingKey = null;
  let encryptionKey = null;

  try {
    signingKey = runtimeModule.getSigningKey(
      hdRoot,
      securitySettings.wallet.coinType,
      securitySettings.wallet.account,
      securitySettings.wallet.signingIndex,
    );
    encryptionKey = runtimeModule.getEncryptionKey(
      hdRoot,
      securitySettings.wallet.coinType,
      securitySettings.wallet.account,
      securitySettings.wallet.encryptionIndex,
    );
  } finally {
    hdRoot.wipe();
    wallet.utils.secureWipe(seed);
  }

  const createdAt =
    normalizeString(currentRecord?.createdAt, null) ?? new Date().toISOString();
  const nextRecord = {
    kind: "sdn-flow-managed-wallet",
    version: 1,
    createdAt,
    label: scopeLabel,
    mnemonic,
    coinType: securitySettings.wallet.coinType,
    account: securitySettings.wallet.account,
    signingIndex: securitySettings.wallet.signingIndex,
    encryptionIndex: securitySettings.wallet.encryptionIndex,
    signingPath: signingKey.path,
    encryptionPath: encryptionKey.path,
    signingPublicKeyHex: wallet.utils.encodeHex(signingKey.publicKey).toUpperCase(),
    encryptionPublicKeyHex: wallet.utils.encodeHex(encryptionKey.publicKey).toUpperCase(),
  };

  if (!compareJsonValues(currentRecord, nextRecord)) {
    await writeSecureJsonFile(paths.walletRecordPath, nextRecord);
  }

  return {
    ...normalizeWalletPublicState({
      ...nextRecord,
      recordPath: paths.walletRecordPath,
      mnemonicWordCount: mnemonic.split(/\s+/).filter(Boolean).length,
      signingFingerprint: buildKeyFingerprint(nextRecord.signingPublicKeyHex),
      encryptionFingerprint: buildKeyFingerprint(nextRecord.encryptionPublicKeyHex),
    }),
    signingPrivateKey: signingKey.privateKey,
    encryptionPrivateKey: encryptionKey.privateKey,
  };
}

async function tryReadExistingTlsState(options = {}) {
  const paths = options.paths;
  const desiredNames = options.desiredNames;
  const walletState = options.walletState;

  if (!(await pathExists(paths.certificatePath)) || !(await pathExists(paths.privateKeyPath))) {
    return null;
  }

  try {
    const [certificatePem, privateKeyPem, metadata] = await Promise.all([
      fs.readFile(paths.certificatePath, "utf8"),
      fs.readFile(paths.privateKeyPath, "utf8"),
      pathExists(paths.tlsMetadataPath)
        ? readJsonFile(paths.tlsMetadataPath).catch(() => null)
        : Promise.resolve(null),
    ]);
    const parsedCertificate = parseCertificateRecord(certificatePem);
    const attestedPublicKey = normalizeString(metadata?.walletPublicKeyHex, "")
      .toUpperCase();

    if (
      parsedCertificate.isCa !== true ||
      !certificateIsCurrentlyValid(parsedCertificate) ||
      !certificateCoversNames(parsedCertificate, desiredNames) ||
      attestedPublicKey !== normalizeString(walletState?.signingPublicKeyHex, "").toUpperCase()
    ) {
      return null;
    }

    return {
      certificatePem,
      privateKeyPem,
      ...normalizeTlsPublicState({
        createdAt:
          normalizeString(metadata?.createdAt, null) ??
          normalizeString(parsedCertificate.notBefore, null),
        subjectDn: parsedCertificate.subjectDn,
        dnsNames: parsedCertificate.dnsNames,
        ipAddresses: parsedCertificate.ipAddresses,
        certificatePath: paths.certificatePath,
        privateKeyPath: paths.privateKeyPath,
        trustCertificatePath: paths.certificatePath,
        metadataPath: paths.tlsMetadataPath,
        walletAttested: metadata?.walletAttested === true,
        reused: true,
      }),
    };
  } catch {
    return null;
  }
}

async function createManagedTlsState(options = {}) {
  const paths = options.paths;
  const securitySettings = options.securitySettings;
  const startup = options.startup;
  const walletState = options.walletState;

  await ensurePrivateDirectory(paths.tlsDir);
  const desiredNames = buildCertificateNames(startup);
  const existingState = await tryReadExistingTlsState({
    paths,
    desiredNames,
    walletState,
  });
  if (existingState) {
    return existingState;
  }

  const configPath = path.join(paths.tlsDir, "openssl.cnf");
  const configText = buildOpenSslConfig(
    desiredNames.commonName,
    desiredNames,
    securitySettings.tls,
  );
  await writeSecureFile(configPath, configText);
  try {
    const generateKey = spawnSync(
      "openssl",
      [
        "ecparam",
        "-name",
        "prime256v1",
        "-genkey",
        "-noout",
        "-out",
        paths.privateKeyPath,
      ],
      {
        cwd: paths.tlsDir,
        encoding: "utf8",
      },
    );
    if (generateKey.error) {
      throw new Error(
        `failed to generate TLS private key: ${generateKey.error.message}`,
      );
    }
    if ((generateKey.status ?? 1) !== 0) {
      throw new Error(
        `failed to generate TLS private key:\n${generateKey.stdout ?? ""}${generateKey.stderr ?? ""}`.trim(),
      );
    }

    const createCertificate = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-new",
        "-sha256",
        "-days",
        String(securitySettings.tls.certificateDays),
        "-key",
        paths.privateKeyPath,
        "-out",
        paths.certificatePath,
        "-config",
        configPath,
        "-extensions",
        "ext",
        "-set_serial",
        `0x${buildSerialHex()}`,
      ],
      {
        cwd: paths.tlsDir,
        encoding: "utf8",
      },
    );
    if (createCertificate.error) {
      throw new Error(
        `failed to generate TLS certificate: ${createCertificate.error.message}`,
      );
    }
    if ((createCertificate.status ?? 1) !== 0) {
      throw new Error(
        `failed to generate TLS certificate:\n${createCertificate.stdout ?? ""}${createCertificate.stderr ?? ""}`.trim(),
      );
    }
  } finally {
    await fs.rm(configPath, { force: true }).catch(() => {});
  }

  const [certificatePem, privateKeyPem] = await Promise.all([
    fs.readFile(paths.certificatePath, "utf8"),
    fs.readFile(paths.privateKeyPath, "utf8"),
  ]);
  const parsedCertificate = parseCertificateRecord(certificatePem);
  const metadata = {
    kind: "sdn-flow-managed-tls",
    version: 1,
    createdAt: new Date().toISOString(),
    subjectDn: parsedCertificate.subjectDn,
    dnsNames: Array.isArray(parsedCertificate.dnsNames)
      ? parsedCertificate.dnsNames
      : desiredNames.dnsNames,
    ipAddresses: Array.isArray(parsedCertificate.ipAddresses)
      ? parsedCertificate.ipAddresses
      : desiredNames.ipAddresses,
    trustCertificatePath: paths.certificatePath,
    walletFingerprint: walletState.signingFingerprint ?? null,
    walletPublicKeyHex: walletState.signingPublicKeyHex ?? null,
    walletAttested: false,
  };

  await Promise.all([
    fs.chmod(paths.certificatePath, 0o600).catch(() => {}),
    fs.chmod(paths.privateKeyPath, 0o600).catch(() => {}),
    writeSecureJsonFile(paths.tlsMetadataPath, metadata),
  ]);

  return {
    certificatePem,
    privateKeyPem,
    ...normalizeTlsPublicState({
      createdAt: metadata.createdAt,
      subjectDn: metadata.subjectDn,
      dnsNames: metadata.dnsNames,
      ipAddresses: metadata.ipAddresses,
      certificatePath: paths.certificatePath,
      privateKeyPath: paths.privateKeyPath,
      trustCertificatePath: paths.certificatePath,
      metadataPath: paths.tlsMetadataPath,
      walletAttested: metadata.walletAttested === true,
      reused: false,
    }),
  };
}

export async function ensureManagedSecurityState(options = {}) {
  const projectRoot = normalizeString(options.projectRoot, null) ?? process.cwd();
  const protocol = normalizeStartupProtocol(options.startup?.protocol, "http");
  const securitySettings = normalizeManagedSecuritySettings(options.security, {
    projectRoot,
    fallback: options.fallback,
  });
  const effectiveSecuritySettings = {
    ...securitySettings,
    wallet: {
      ...securitySettings.wallet,
      enabled: securitySettings.wallet.enabled || protocol === "https",
    },
    tls: {
      ...securitySettings.tls,
      enabled: securitySettings.tls.enabled || protocol === "https",
    },
  };
  const paths = getManagedSecurityPaths({
    projectRoot,
    storageDir: effectiveSecuritySettings.storageDir,
    scopeId: options.scopeId,
  });
  const scopeLabel = normalizeString(options.scopeLabel, "sdn-flow managed security") ??
    "sdn-flow managed security";
  const wallet = await getHdWalletRuntime();
  const runtimeModule = await importHdWalletRuntimeModule();

  let walletState = null;
  let tlsState = null;
  try {
    if (effectiveSecuritySettings.wallet.enabled) {
      walletState = await ensureManagedWalletState({
        wallet,
        runtimeModule,
        paths,
        securitySettings: effectiveSecuritySettings,
        scopeLabel,
      });
    }
    if (effectiveSecuritySettings.tls.enabled) {
      if (!walletState) {
        throw new Error("Managed TLS requires a wallet-backed signing key.");
      }
      tlsState = await createManagedTlsState({
        paths,
        securitySettings: effectiveSecuritySettings,
        startup: options.startup,
        walletState,
      });
    }

    return {
      settings: cloneJsonCompatibleValue(effectiveSecuritySettings),
      storageDir: effectiveSecuritySettings.storageDir,
      wallet: walletState ? normalizeWalletPublicState(walletState) : { enabled: false },
      tls: tlsState ? normalizeTlsPublicState(tlsState) : { enabled: false },
      serverOptions:
        tlsState && protocol === "https"
          ? {
              key: tlsState.privateKeyPem,
              cert: tlsState.certificatePem,
            }
          : null,
    };
  } finally {
    if (walletState?.signingPrivateKey) {
      wallet.utils.secureWipe(walletState.signingPrivateKey);
    }
    if (walletState?.encryptionPrivateKey) {
      wallet.utils.secureWipe(walletState.encryptionPrivateKey);
    }
  }
}

export default {
  createDefaultEditorManagedSecuritySettings,
  ensureManagedSecurityState,
  getDefaultManagedSecurityStorageDir,
  getManagedSecurityPaths,
  normalizeManagedSecuritySettings,
  normalizeStartupProtocol,
};
