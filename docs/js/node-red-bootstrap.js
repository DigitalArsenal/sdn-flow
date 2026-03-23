(function () {
  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function formatBytes(value) {
    const size = Number(value ?? 0);
    if (!Number.isFinite(size) || size <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    let unitIndex = 0;
    let scaled = size;
    while (scaled >= 1024 && unitIndex < units.length - 1) {
      scaled /= 1024;
      unitIndex += 1;
    }
    return `${scaled >= 10 || unitIndex === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unitIndex]}`;
  }

  function formatDate(value) {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return String(value ?? "");
    }
  }

  function parseJsonText(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function normalizeBasePath(value, fallback = "/") {
    const normalized = String(value ?? fallback).trim() || fallback;
    if (normalized === "/") {
      return "/";
    }
    const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  }

  function normalizePort(value, fallback = 1990) {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function normalizeProtocol(value, fallback = "http") {
    const normalized = String(value ?? fallback).trim().toLowerCase();
    return normalized === "https" ? "https" : "http";
  }

  function normalizeArtifactArchiveLimit(value, fallback = 100) {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function normalizeSecuritySettings(value = {}, fallback = {}) {
    return {
      storageDir: String(value?.storageDir ?? fallback?.storageDir ?? "").trim(),
    };
  }

  function normalizeRuntimeSettings(value = {}, fallback = {}) {
    return {
      protocol: normalizeProtocol(value.protocol, fallback.protocol ?? "http"),
      hostname: String(value.hostname ?? fallback.hostname ?? "127.0.0.1").trim() || "127.0.0.1",
      port: normalizePort(value.port, fallback.port ?? 1990),
      basePath: normalizeBasePath(value.basePath, fallback.basePath ?? "/"),
      title: String(value.title ?? fallback.title ?? "sdn-flow Editor").trim() || "sdn-flow Editor",
      artifactArchiveLimit: normalizeArtifactArchiveLimit(
        value.artifactArchiveLimit,
        fallback.artifactArchiveLimit ?? 100,
      ),
      security: normalizeSecuritySettings(value.security, fallback.security ?? {}),
    };
  }

  function buildEditorUrl(startup = {}) {
    const settings = normalizeRuntimeSettings(startup);
    const basePath = settings.basePath === "/" ? "/" : `${settings.basePath}/`;
    return `${settings.protocol}://${settings.hostname}:${settings.port}${basePath}`;
  }

  async function fetchJson(path, options) {
    const response = await fetch(path, {
      cache: "no-store",
      ...options,
      headers: {
        accept: "application/json",
        ...(options?.headers || {}),
      },
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Request failed with ${response.status}`);
    }
    return response.json();
  }

  function ensureOverlay() {
    let overlay = document.getElementById("sdn-flow-compile-overlay");
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "sdn-flow-compile-overlay";
      overlay.innerHTML = `
        <div class="sdn-flow-compile-card">
          <div class="sdn-flow-compile-title">Compile In Progress</div>
          <div class="sdn-flow-compile-copy" id="sdn-flow-compile-overlay-message"></div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    return overlay;
  }

  function showCompileOverlay(message) {
    const overlay = ensureOverlay();
    const messageEl = document.getElementById("sdn-flow-compile-overlay-message");
    if (messageEl) {
      messageEl.textContent = message;
    }
    overlay.classList.add("visible");
  }

  function hideCompileOverlay() {
    document.getElementById("sdn-flow-compile-overlay")?.classList.remove("visible");
  }

  function triggerDownload(downloadPath) {
    const anchor = document.createElement("a");
    anchor.href = new URL(downloadPath, window.location.href).toString();
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  function replaceMenuIcon(link, iconClass) {
    if (!link || !iconClass) {
      return;
    }
    const icon = document.createElement("i");
    icon.className = iconClass;
    const existingIcon = link.querySelector(":scope > img, :scope > i:not(.fa-square):not(.fa-check-square)");
    if (existingIcon) {
      existingIcon.replaceWith(icon);
      return;
    }
    link.prepend(icon);
  }

  function updateDeployMenuItem(itemId, details = {}) {
    const link = document.getElementById(itemId);
    if (!link) {
      return false;
    }
    link.querySelectorAll(":scope > i.fa-square, :scope > i.fa-check-square").forEach((icon) => {
      icon.remove();
    });
    const labelElement =
      link.querySelector(".red-ui-menu-label-container .red-ui-menu-label") ??
      link.querySelector(".red-ui-menu-label > span") ??
      link.querySelector(".red-ui-menu-label");
    if (labelElement && details.label) {
      labelElement.textContent = details.label;
    }
    const sublabelElement = link.querySelector(".red-ui-menu-sublabel");
    if (sublabelElement) {
      if (details.sublabel) {
        sublabelElement.textContent = details.sublabel;
        sublabelElement.style.display = "";
      } else {
        sublabelElement.style.display = "none";
      }
    }
    if (details.iconClass) {
      replaceMenuIcon(link, details.iconClass);
    }
    return true;
  }

  function cleanupDeployMenuSeparators() {
    const submenu = document.getElementById("red-ui-header-button-deploy-options-submenu");
    if (!submenu) {
      return;
    }
    const items = Array.from(submenu.children);
    for (const item of items) {
      if (!item.classList.contains("red-ui-menu-divider")) {
        item.style.display = "";
        continue;
      }
      const previousVisible = items
        .slice(0, items.indexOf(item))
        .reverse()
        .some(
          (candidate) =>
            !candidate.classList.contains("red-ui-menu-divider") &&
            !candidate.classList.contains("hide") &&
            candidate.style.display !== "none",
        );
      const nextVisible = items
        .slice(items.indexOf(item) + 1)
        .some(
          (candidate) =>
            !candidate.classList.contains("red-ui-menu-divider") &&
            !candidate.classList.contains("hide") &&
            candidate.style.display !== "none",
        );
      item.style.display = previousVisible && nextVisible ? "" : "none";
    }
  }

  function hideDeployMenuItem(itemId) {
    if (typeof window.RED?.menu?.setVisible === "function") {
      window.RED.menu.setVisible(itemId, false);
    }
    const link = document.getElementById(itemId);
    const listItem = link?.closest("li");
    if (listItem) {
      listItem.classList.add("hide");
      listItem.style.display = "none";
    }
  }

  function hideDeployMenuExtras() {
    ["deploymenu-item-runtime-start", "deploymenu-item-runtime-stop", "deploymenu-item-reload"].forEach(
      (itemId) => {
        hideDeployMenuItem(itemId);
      },
    );
    cleanupDeployMenuSeparators();
  }

  function overrideTranslations() {
    if (typeof i18next?.addResourceBundle !== "function") {
      return;
    }
    i18next.addResourceBundle(
      "en-US",
      "editor",
      {
        deploy: {
          deploy: "Compile",
          successfulDeploy: "Successfully compiled",
          successfulRestart: "Successfully compiled and restarted",
          deployFailed: "Compile failed: __message__",
        },
      },
      true,
      true,
    );
    i18next.addResourceBundle(
      "en-US",
      "node-red",
      {
        debug: {
          node: "node",
          sidebar: {
            label: "runtime",
            name: "Runtime Debug",
            filterAll: "all nodes",
            all: "all",
          },
        },
        file: {
          label: {
            write: "write file",
            read: "read file",
          },
        },
      },
      true,
      true,
    );
    i18next.addResourceBundle(
      "en-US",
      "debug",
      {
        node: "node",
        sidebar: {
          label: "runtime",
          name: "Runtime Debug",
        },
      },
      true,
      true,
    );
    i18next.addResourceBundle(
      "en-US",
      "file",
      {
        label: {
          write: "write file",
          read: "read file",
        },
      },
      true,
      true,
    );
  }

  function createTopicMatcher(pattern) {
    return new RegExp(
      "^" +
        pattern
          .replace(/([\[\]\?\(\)\\$\^*\.|])/g, "\\$1")
          .replace(/\+/g, "[^/]+")
          .replace(/\/#$/, "(\\/.*)?") +
        "$",
    );
  }

  const commsSubscriptions = new Map();
  const commsEventHandlers = new Map();
  let commsConnected = false;
  let runtimePollTimer = null;
  let runtimeStatusCache = null;
  let runtimeStateCache = null;
  let runtimeDebugSequence = 0;
  let runtimeSettingsCache = null;
  let restartPollTimer = null;
  let archiveTabReady = false;
  let compilePreviewTabReady = false;
  let compilePreviewPollTimer = null;
  let compilePreviewRefreshTimer = null;
  let compilePreviewRefreshPending = false;
  let compilePreviewRefreshForced = false;
  let compilePreviewLoading = false;
  let compilePreviewLastFingerprint = null;
  let compilePreviewVisible = false;
  let compilePreviewEditor = null;
  let compilePreviewModel = null;
  let compilePreviewResizeObserver = null;
  let compilePreviewContent = null;
  let deployMenuUiInstalled = false;
  let securityPopupReady = false;
  let documentationPrunerInstalled = false;
  let documentationPrunerTimer = null;
  const rawLabelOverrides = new Map(
    Object.entries({
      "debug.sidebar.label": "runtime",
      "debug.sidebar.filterAll": "all nodes",
      "debug.sidebar.all": "all",
      "file.label.write": "write file",
      "file.label.read": "read file",
    }),
  );
  const SDN_FLOW_BRAND_ICON_PATH = "brand/sdn-flow-icon.svg";
  const SDN_FLOW_BRAND_LOGO_PATH = "brand/sdn-flow-logo.svg";

  function emitCommsEvent(eventName, ...args) {
    const handlers = commsEventHandlers.get(eventName) ?? [];
    handlers.slice().forEach((handler) => {
      try {
        handler(...args);
      } catch (error) {
        console.warn(`sdn-flow comms handler failed for ${eventName}:`, error);
      }
    });
  }

  function notifyTopicSubscribers(topic, payload) {
    let delivered = true;
    for (const [pattern, handlers] of commsSubscriptions.entries()) {
      if (!createTopicMatcher(pattern).test(topic)) {
        continue;
      }
      handlers.slice().forEach((handler) => {
        try {
          handler(topic, payload);
        } catch (error) {
          delivered = false;
          console.warn(`sdn-flow subscription handler failed for ${topic}:`, error);
        }
      });
    }
    return delivered;
  }

  function canRenderDebugEventPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return true;
    }
    const path = String(payload.path ?? "").trim();
    if (!path || path === "global") {
      return true;
    }
    const flowId = path.split("/")[0];
    const workspace =
      typeof window.RED?.nodes?.workspace === "function"
        ? window.RED.nodes.workspace(flowId)
        : null;
    const sourceNode =
      typeof window.RED?.nodes?.node === "function"
        ? window.RED.nodes.node(payload.id)
        : null;
    return Boolean(workspace || sourceNode);
  }

  function ensureConnectionIndicator() {
    let indicator = document.getElementById("sdn-flow-connection-indicator");
    if (indicator) {
      return indicator;
    }
    const toolbar = document.querySelector(".red-ui-header-toolbar");
    if (!toolbar) {
      return null;
    }
    const item = document.createElement("li");
    item.innerHTML = `
      <div id="sdn-flow-connection-indicator" class="sdn-flow-connection-indicator disconnected">
        <span class="sdn-flow-connection-dot" aria-hidden="true"></span>
        <span class="sdn-flow-connection-label">Server disconnected</span>
      </div>
    `;
    toolbar.prepend(item);
    indicator = document.getElementById("sdn-flow-connection-indicator");
    return indicator;
  }

  function installBranding() {
    const favicon =
      document.querySelector('link[rel="icon"]') ||
      document.querySelector('link[rel="shortcut icon"]');
    if (favicon) {
      favicon.setAttribute("href", SDN_FLOW_BRAND_ICON_PATH);
      favicon.setAttribute("type", "image/svg+xml");
    }
    const logoLink = document.querySelector("#red-ui-header .red-ui-header-logo");
    if (logoLink) {
      logoLink.setAttribute("href", "https://github.com/DigitalArsenal/sdn-flow");
      logoLink.setAttribute("title", "sdn-flow");
      logoLink.setAttribute("aria-label", "sdn-flow");
      let logoImage = logoLink.querySelector("img");
      if (!logoImage) {
        logoImage = document.createElement("img");
        logoLink.replaceChildren(logoImage);
      }
      logoImage.setAttribute("src", SDN_FLOW_BRAND_LOGO_PATH);
      logoImage.setAttribute("alt", "sdn-flow");
    }
  }

  function installDeployMenuUi() {
    if (deployMenuUiInstalled) {
      hideDeployMenuExtras();
      return;
    }
    if (
      !window.RED?.menu?.setAction ||
      !window.RED?.menu?.setVisible ||
      !window.RED?.menu?.setSelected
    ) {
      return;
    }
    const deployButton = document.getElementById("red-ui-header-button-deploy");
    const deployOptionsButton = document.getElementById("red-ui-header-button-deploy-options");
    if (!deployButton || !deployOptionsButton) {
      return;
    }

    deployMenuUiInstalled = true;
    window.RED.menu.setAction("deploymenu-item-flow", (selected) => {
      if (selected === false) {
        return;
      }
      triggerDownload("api/download/wasm");
      window.setTimeout(() => {
        window.RED.menu.setSelected("deploymenu-item-full", true);
      }, 0);
    });
    window.RED.menu.setAction("deploymenu-item-node", (selected) => {
      if (selected === false) {
        return;
      }
      triggerDownload("api/download/executable");
      window.setTimeout(() => {
        window.RED.menu.setSelected("deploymenu-item-full", true);
      }, 0);
    });

    updateDeployMenuItem("deploymenu-item-full", {
      label: "Full",
      sublabel: "Compile the full workspace and refresh the runtime.",
    });
    updateDeployMenuItem("deploymenu-item-flow", {
      label: "Download WASM Artifact",
      sublabel: "Download the compiled WASM flow artifact.",
      iconClass: "fa fa-file-code-o",
    });
    updateDeployMenuItem("deploymenu-item-node", {
      label: "Download Standalone Executable",
      sublabel: "Download the rebuilt standalone executable.",
      iconClass: "fa fa-cube",
    });

    deployOptionsButton.addEventListener("click", () => {
      window.setTimeout(() => {
        hideDeployMenuExtras();
      }, 0);
    });
    window.RED.menu.setSelected("deploymenu-item-full", true);
    hideDeployMenuExtras();
  }

  function pruneDocumentationChrome() {
    const red = window.RED;
    if (typeof red?.menu?.removeItem === "function") {
      red.menu.removeItem("menu-item-help");
      red.menu.removeItem("menu-item-node-red-version");
      red.menu.removeItem("menu-item-view-menu-help");
    }
    const preferredSidebarTabId =
      document.querySelector('[href="#debug"]')
        ? "debug"
        : document.querySelector('[href="#sdn-flow-archives"]')
            ? "sdn-flow-archives"
            : document.querySelector('[href="#sdn-flow-compile-preview"]')
              ? "sdn-flow-compile-preview"
              : null;
    if (
      preferredSidebarTabId &&
      (window.location.hash === "#info" || document.querySelector("#red-ui-tab-info-link-button.active"))
    ) {
      if (typeof red?.sidebar?.show === "function") {
        red.sidebar.show(preferredSidebarTabId);
      } else {
        document.querySelector(`[href="#${preferredSidebarTabId}"]`)?.click();
      }
    }
    document.querySelectorAll('a[href="#info"]').forEach((link) => {
      (link.closest("li") ?? link).style.display = "none";
    });
    document.querySelectorAll('a[href="#help"]').forEach((link) => {
      (link.closest("li") ?? link).style.display = "none";
    });
    document
      .querySelectorAll(
        '[id*="sidebar-tab-help"], [href*="#help"], [aria-controls*="help"], [aria-controls*="info"]',
      )
      .forEach((element) => {
        (element.closest("li") ?? element).style.display = "none";
      });
    document.querySelectorAll(".fa-book").forEach((icon) => {
      const control = icon.closest("button,a");
      if (control) {
        control.style.display = "none";
      }
    });
    document.querySelectorAll(".red-ui-help-tips").forEach((element) => {
      element.remove();
    });
    document.querySelectorAll('a[href*="nodered.org"]').forEach((link) => {
      link.setAttribute("href", "https://github.com/DigitalArsenal/sdn-flow");
      link.setAttribute("target", "_blank");
    });
    if (typeof document.createTreeWalker === "function") {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let currentNode = walker.nextNode();
      while (currentNode) {
        const originalText = currentNode.nodeValue ?? "";
        let nextText = originalText;
        rawLabelOverrides.forEach((replacement, key) => {
          if (nextText.includes(key)) {
            nextText = nextText.replaceAll(key, replacement);
          }
        });
        if (nextText !== originalText) {
          currentNode.nodeValue = nextText;
        }
        currentNode = walker.nextNode();
      }
    }
  }

  function installDocumentationPruner() {
    if (documentationPrunerInstalled) {
      pruneDocumentationChrome();
      return;
    }
    documentationPrunerInstalled = true;
    pruneDocumentationChrome();
    let attempts = 0;
    documentationPrunerTimer = window.setInterval(() => {
      attempts += 1;
      pruneDocumentationChrome();
      if (attempts >= 20 && documentationPrunerTimer) {
        clearInterval(documentationPrunerTimer);
        documentationPrunerTimer = null;
      }
    }, 250);
  }

  function updateConnectionIndicator(connected, status) {
    const indicator = ensureConnectionIndicator();
    if (!indicator) {
      return;
    }
    indicator.classList.toggle("connected", connected);
    indicator.classList.toggle("disconnected", !connected);
    const label = indicator.querySelector(".sdn-flow-connection-label");
    const activeBuild = status?.activeBuild ?? null;
    const activeArtifactName =
      activeBuild?.outputName ||
      activeBuild?.programId ||
      activeBuild?.artifactId ||
      null;
    if (label) {
      if (!connected) {
        label.textContent = "Server disconnected";
      } else if (status?.compiledRuntimeLoaded && activeArtifactName) {
        label.textContent = `Connected · ${activeArtifactName}`;
      } else if (status?.compiledRuntimeLoaded) {
        label.textContent = "Connected · runtime loaded";
      } else {
        label.textContent = "Connected · no runtime";
      }
    }
    const targetUrl =
      status?.activeStartup && status?.activeStartup.hostname
        ? buildEditorUrl(status.activeStartup)
        : window.location.href;
    const compileId = status?.activeBuild?.compileId ? `compile ${status.activeBuild.compileId}` : null;
    const createdAt = status?.activeBuild?.createdAt ? formatDate(status.activeBuild.createdAt) : null;
    const titleParts = [targetUrl];
    if (activeArtifactName) {
      titleParts.push(`Loaded artifact: ${activeArtifactName}`);
    }
    if (compileId) {
      titleParts.push(compileId);
    }
    if (createdAt) {
      titleParts.push(`Built ${createdAt}`);
    }
    indicator.title = titleParts.join("\n");
  }

  function applyRuntimeStatus(status) {
    const previousRuntimeId = window.__sdnFlowRuntimeId ?? null;
    runtimeStatusCache = status;
    runtimeSettingsCache = normalizeRuntimeSettings(
      {
        ...(status?.startup ?? {}),
        artifactArchiveLimit: status?.artifactArchiveLimit,
        security: status?.security,
      },
      runtimeSettingsCache ?? {},
    );
    window.__sdnFlowRuntimeId = status?.runtimeId ?? null;
    if (previousRuntimeId && status?.runtimeId && status.runtimeId !== previousRuntimeId) {
      runtimeDebugSequence = 0;
    }
    const nextDebugSequence = Number(status?.debugSequence ?? 0);
    if (nextDebugSequence < runtimeDebugSequence) {
      runtimeDebugSequence = 0;
    }
    updateConnectionIndicator(true, status);
    hideDeployMenuExtras();
    if (!commsConnected) {
      commsConnected = true;
      emitCommsEvent("connect");
    }
    const nextState = status?.flowState ?? "start";
    if (runtimeStateCache !== nextState) {
      runtimeStateCache = nextState;
    }
    const debugEvents = Array.isArray(status?.debugMessages) ? status.debugMessages : [];
    for (const event of debugEvents) {
      const sequence = Number(event?.sequence ?? 0);
      if (sequence <= runtimeDebugSequence) {
        continue;
      }
      const payload = event?.message ?? event;
      if (!canRenderDebugEventPayload(payload)) {
        break;
      }
      if (!notifyTopicSubscribers("debug", payload)) {
        break;
      }
      runtimeDebugSequence = sequence;
    }
    notifyTopicSubscribers("notification/runtime-state", {
      state: nextState,
    });
    renderSecurityStatus(findSecurityDialog(), status);
  }

  function applyRuntimeDisconnect() {
    updateConnectionIndicator(false, runtimeStatusCache);
    if (commsConnected) {
      commsConnected = false;
      emitCommsEvent("disconnect");
    }
  }

  async function refreshRuntimeStatus() {
    try {
      const status = await fetchJson("api/runtime-status");
      applyRuntimeStatus(status);
      return status;
    } catch {
      applyRuntimeDisconnect();
      return null;
    }
  }

  function startRuntimePolling() {
    if (runtimePollTimer) {
      return;
    }
    const poll = async () => {
      await refreshRuntimeStatus();
    };
    void poll();
    runtimePollTimer = window.setInterval(() => {
      void poll();
    }, 1000);
  }

  function installCommsBridge() {
    if (window.__sdnFlowCommsInstalled || !window.RED) {
      return;
    }
    window.__sdnFlowCommsInstalled = true;
    RED.comms = {
      connect() {
        startRuntimePolling();
      },
      subscribe(topic, callback) {
        const handlers = commsSubscriptions.get(topic) ?? [];
        handlers.push(callback);
        commsSubscriptions.set(topic, handlers);
      },
      unsubscribe(topic, callback) {
        const handlers = commsSubscriptions.get(topic);
        if (!handlers) {
          return;
        }
        const nextHandlers = handlers.filter((handler) => handler !== callback);
        if (nextHandlers.length === 0) {
          commsSubscriptions.delete(topic);
          return;
        }
        commsSubscriptions.set(topic, nextHandlers);
      },
      send() {},
      on(eventName, callback) {
        const handlers = commsEventHandlers.get(eventName) ?? [];
        handlers.push(callback);
        commsEventHandlers.set(eventName, handlers);
      },
      off(eventName, callback) {
        const handlers = commsEventHandlers.get(eventName);
        if (!handlers) {
          return;
        }
        const nextHandlers = handlers.filter((handler) => handler !== callback);
        if (nextHandlers.length === 0) {
          commsEventHandlers.delete(eventName);
          return;
        }
        commsEventHandlers.set(eventName, nextHandlers);
      },
    };
  }

  function resolveRestartUrl(xhr) {
    const headerUrl = xhr.getResponseHeader("x-sdn-flow-restart-url");
    if (headerUrl) {
      return headerUrl;
    }
    const payload = xhr.responseJSON ?? parseJsonText(xhr.responseText);
    return payload?.restartUrl ?? window.__sdnFlowDesiredRestartUrl ?? null;
  }

  function getRuntimeStatusPollUrl(restartUrl) {
    if (!restartUrl) {
      return "api/runtime-status";
    }
    try {
      return new URL("api/runtime-status", restartUrl).toString();
    } catch {
      return "api/runtime-status";
    }
  }

  function getEditorNavigationUrl(restartUrl) {
    if (!restartUrl) {
      return window.location.href;
    }
    try {
      return new URL(restartUrl, window.location.href).toString();
    } catch {
      return window.location.href;
    }
  }

  function pollForCompile(previousRuntimeId, restartUrl, restartPending) {
    if (restartPollTimer) {
      clearInterval(restartPollTimer);
    }
    const runtimeStatusUrl = getRuntimeStatusPollUrl(restartUrl);
    const editorUrl = getEditorNavigationUrl(restartUrl);
    restartPollTimer = setInterval(async () => {
      try {
        const status = await fetchJson(runtimeStatusUrl);
        if (restartPending && status?.runtimeId && status.runtimeId !== previousRuntimeId) {
          clearInterval(restartPollTimer);
          restartPollTimer = null;
          window.location.assign(editorUrl);
          return;
        }
        if (status?.compilePending === false && status?.lastCompileError) {
          clearInterval(restartPollTimer);
          restartPollTimer = null;
          hideCompileOverlay();
          if (window.RED?.notify) {
            RED.notify(String(status.lastCompileError), "error");
          }
          return;
        }
        if (status?.compilePending === false) {
          clearInterval(restartPollTimer);
          restartPollTimer = null;
          hideCompileOverlay();
          if (!restartPending && window.RED?.notify) {
            RED.notify("Compile complete", "success");
          }
        }
      } catch {
        // Ignore transient restart polling failures while the old host exits.
      }
    }, 1200);
  }

  function waitForMonaco(timeoutMs = 10000) {
    if (window.monaco?.editor?.create) {
      return Promise.resolve(window.monaco);
    }
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        if (window.monaco?.editor?.create) {
          clearInterval(timer);
          resolve(window.monaco);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          clearInterval(timer);
          reject(new Error("Monaco editor did not load."));
        }
      }, 50);
    });
  }

  function getCurrentEditorFlows() {
    if (typeof window.RED?.nodes?.createCompleteNodeSet !== "function") {
      return null;
    }
    return RED.nodes.createCompleteNodeSet({
      sort: false,
    });
  }

  function getFlowFingerprint(flows) {
    try {
      return JSON.stringify(flows ?? null);
    } catch {
      return `unserializable-${Date.now()}`;
    }
  }

  function setCompilePreviewMeta(message, tone = "") {
    const meta = document.getElementById("sdn-flow-compile-preview-meta");
    if (!meta) {
      return;
    }
    meta.textContent = message;
    meta.classList.toggle("error", tone === "error");
  }

  function renderCompilePreviewWarnings(warnings) {
    const container = document.getElementById("sdn-flow-compile-preview-warnings");
    if (!container) {
      return;
    }
    const items = Array.isArray(warnings)
      ? warnings.filter((warning) => String(warning ?? "").trim().length > 0)
      : [];
    if (items.length === 0) {
      container.hidden = true;
      container.innerHTML = "";
      return;
    }
    container.hidden = false;
    container.innerHTML = items
      .map((warning) => `<div class="sdn-flow-compile-preview-warning">${escapeHtml(warning)}</div>`)
      .join("");
  }

  async function ensureCompilePreviewEditor() {
    if (compilePreviewEditor) {
      return compilePreviewEditor;
    }
    if (!compilePreviewContent) {
      return null;
    }
    const monaco = await waitForMonaco();
    const container = document.getElementById("sdn-flow-compile-preview-editor");
    if (!container) {
      throw new Error("Compile preview container not found.");
    }
    compilePreviewModel = monaco.editor.createModel("", "cpp");
    compilePreviewEditor = monaco.editor.create(container, {
      model: compilePreviewModel,
      automaticLayout: true,
      readOnly: true,
      minimap: {
        enabled: false,
      },
      scrollBeyondLastLine: false,
      renderLineHighlight: "none",
      theme: "vs",
      fontSize: 12,
      wordWrap: "off",
      padding: {
        top: 10,
        bottom: 10,
      },
    });
    if (typeof ResizeObserver === "function") {
      compilePreviewResizeObserver = new ResizeObserver(() => {
        compilePreviewEditor?.layout();
      });
      compilePreviewResizeObserver.observe(container);
    }
    return compilePreviewEditor;
  }

  function applyCompilePreview(preview) {
    if (compilePreviewModel) {
      compilePreviewModel.setValue(String(preview?.source ?? ""));
    }
    renderCompilePreviewWarnings(preview?.warnings);
    const outputName = preview?.outputName ? `${preview.outputName}.wasm` : "preview";
    const generator = preview?.sourceGeneratorModel ?? "generator";
    setCompilePreviewMeta(`Exact compile source for ${outputName} via ${generator}.`);
    compilePreviewEditor?.layout();
  }

  async function refreshCompilePreview(options = {}) {
    const flows = getCurrentEditorFlows();
    if (!Array.isArray(flows)) {
      return;
    }
    if (!compilePreviewVisible && !compilePreviewEditor) {
      return;
    }
    const fingerprint = getFlowFingerprint(flows);
    if (!options.force && fingerprint === compilePreviewLastFingerprint) {
      return;
    }
    if (compilePreviewLoading) {
      compilePreviewRefreshPending = true;
      compilePreviewRefreshForced = compilePreviewRefreshForced || options.force === true;
      return;
    }

    compilePreviewLoading = true;
    try {
      await ensureCompilePreviewEditor();
      setCompilePreviewMeta("Generating C++ preview...");
      const preview = await fetchJson("api/compile-preview", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          flows,
        }),
      });
      compilePreviewLastFingerprint = fingerprint;
      applyCompilePreview(preview);
    } catch (error) {
      renderCompilePreviewWarnings([]);
      if (compilePreviewModel) {
        compilePreviewModel.setValue(`// Failed to generate preview\n${String(error?.message || error)}`);
      }
      setCompilePreviewMeta("Preview failed.", "error");
      if (window.RED?.notify) {
        RED.notify(String(error?.message || error), "error");
      }
    } finally {
      compilePreviewLoading = false;
      if (compilePreviewRefreshPending) {
        const force = compilePreviewRefreshForced;
        compilePreviewRefreshPending = false;
        compilePreviewRefreshForced = false;
        scheduleCompilePreviewRefresh({
          force,
          delay: 50,
        });
      }
    }
  }

  function scheduleCompilePreviewRefresh(options = {}) {
    if (compilePreviewRefreshTimer) {
      clearTimeout(compilePreviewRefreshTimer);
    }
    compilePreviewRefreshTimer = setTimeout(() => {
      compilePreviewRefreshTimer = null;
      void refreshCompilePreview({
        force: options.force === true,
      });
    }, options.delay ?? 180);
  }

  function startCompilePreviewSync() {
    if (compilePreviewPollTimer) {
      return;
    }
    compilePreviewPollTimer = window.setInterval(() => {
      void refreshCompilePreview();
    }, 750);
  }

  async function renderArchives(container) {
    container.innerHTML = `<div class="sdn-flow-archives-empty">Loading archived flow builds...</div>`;
    try {
      const archives = await fetchJson("api/archives");
      if (!Array.isArray(archives) || archives.length === 0) {
        container.innerHTML = `
          <div class="sdn-flow-archives-empty">
            No archived flow builds yet.
          </div>
        `;
        return;
      }
      container.innerHTML = archives
        .map(
          (archive) => `
            <article class="sdn-flow-archive-row" data-archive-id="${escapeHtml(archive.id)}">
              <div class="sdn-flow-archive-meta">
                <div class="sdn-flow-archive-name">${escapeHtml(archive.name)}</div>
                <div class="sdn-flow-archive-detail">
                  ${escapeHtml(archive.programId || archive.outputName || archive.artifactId || archive.id)}
                </div>
                <div class="sdn-flow-archive-detail">${escapeHtml(formatDate(archive.modifiedAt))}</div>
                <div class="sdn-flow-archive-detail">
                  ${escapeHtml(
                    `${formatBytes(archive.wasmBytes || 0)} wasm, ${archive.flowCount || 0} flow nodes`,
                  )}
                </div>
              </div>
              <button class="red-ui-button red-ui-button-small sdn-flow-archive-delete" type="button">Delete</button>
            </article>
          `,
        )
        .join("");
      container.querySelectorAll(".sdn-flow-archive-delete").forEach((button) => {
        button.addEventListener("click", async (event) => {
          const row = event.currentTarget.closest("[data-archive-id]");
          const archiveId = row?.dataset.archiveId;
          if (!archiveId) {
            return;
          }
          event.currentTarget.disabled = true;
          try {
            await fetchJson(`api/archives/${encodeURIComponent(archiveId)}`, {
              method: "DELETE",
            });
            await renderArchives(container);
          } catch (error) {
            RED.notify(String(error?.message || error), "error");
            event.currentTarget.disabled = false;
          }
        });
      });
    } catch (error) {
      container.innerHTML = `
        <div class="sdn-flow-archives-empty">
          Failed to load archived flow builds.
        </div>
      `;
      if (window.RED?.notify) {
        RED.notify(String(error?.message || error), "error");
      }
    }
  }

  function installArchiveTab() {
    if (archiveTabReady || !window.RED?.sidebar?.addTab) {
      return;
    }
    archiveTabReady = true;
    const content = document.createElement("div");
    content.className = "sdn-flow-archives-panel";
    RED.sidebar.addTab({
      id: "sdn-flow-archives",
      label: "archives",
      name: "Flow Archives",
      iconClass: "fa fa-archive",
      content,
      onchange() {
        renderArchives(content);
      },
    });
  }

  function installCompilePreviewTab() {
    if (compilePreviewTabReady || !window.RED?.sidebar?.addTab) {
      return;
    }
    compilePreviewTabReady = true;
    compilePreviewContent = document.createElement("div");
    compilePreviewContent.className = "sdn-flow-compile-preview-panel";
    compilePreviewContent.innerHTML = `
      <div class="sdn-flow-compile-preview-shell">
        <div class="sdn-flow-compile-preview-toolbar">
          <div class="sdn-flow-compile-preview-title">Generated C++</div>
          <div id="sdn-flow-compile-preview-meta" class="sdn-flow-compile-preview-meta">Waiting for flow graph...</div>
        </div>
        <div id="sdn-flow-compile-preview-warnings" class="sdn-flow-compile-preview-warnings" hidden></div>
        <div id="sdn-flow-compile-preview-editor" class="sdn-flow-compile-preview-editor"></div>
      </div>
    `;
    RED.sidebar.addTab({
      id: "sdn-flow-compile-preview",
      label: "c++",
      name: "Generated C++",
      iconClass: "fa fa-file-code-o",
      content: compilePreviewContent,
      onchange() {
        compilePreviewVisible = true;
        void ensureCompilePreviewEditor()
          .then(() => {
            compilePreviewEditor?.layout();
            scheduleCompilePreviewRefresh({
              force: true,
              delay: 10,
            });
          })
          .catch((error) => {
            setCompilePreviewMeta("Preview failed.", "error");
            if (window.RED?.notify) {
              RED.notify(String(error?.message || error), "error");
            }
          });
      },
      onclose() {
        compilePreviewVisible = false;
      },
    });
    startCompilePreviewSync();
  }

  function getRuntimeSettingsFallback() {
    return normalizeRuntimeSettings(
      {
        ...(runtimeStatusCache?.startup ?? {}),
        artifactArchiveLimit: runtimeStatusCache?.artifactArchiveLimit,
        security: runtimeStatusCache?.security,
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
        port: 1990,
        basePath: "/",
        title: "sdn-flow Editor",
        artifactArchiveLimit: 100,
        security: {
          storageDir: "",
        },
      },
    );
  }

  function mergeRuntimeStatus(status = {}) {
    return {
      ...(runtimeStatusCache ?? {}),
      ...status,
      startup: status?.startup ?? runtimeStatusCache?.startup ?? null,
      activeStartup:
        status?.activeStartup ??
        runtimeStatusCache?.activeStartup ??
        status?.startup ??
        null,
      security: status?.security ?? runtimeStatusCache?.security ?? null,
      activeSecurity:
        status?.activeSecurity ??
        runtimeStatusCache?.activeSecurity ??
        status?.security ??
        null,
      securityStatus:
        status?.securityStatus ?? runtimeStatusCache?.securityStatus ?? null,
      artifactArchiveLimit:
        status?.artifactArchiveLimit ??
        runtimeStatusCache?.artifactArchiveLimit ??
        100,
      restartUrl: status?.restartUrl ?? runtimeStatusCache?.restartUrl ?? null,
    };
  }

  function setSecurityStatusValue(root, selector, value) {
    const element = root.querySelector(selector);
    if (!element) {
      return;
    }
    const text = String(value ?? "").trim();
    element.textContent = text || "Not available";
    element.title = text || "";
  }

  function formatStatusList(values = []) {
    const items = Array.isArray(values) ? values.filter(Boolean) : [];
    return items.length > 0 ? items.join(", ") : "Not available";
  }

  function renderSecurityStatus(root, status = runtimeStatusCache) {
    if (!root) {
      return;
    }
    const mergedStatus = mergeRuntimeStatus(status ?? {});
    const securityStatus = mergedStatus?.securityStatus ?? {};
    const wallet = securityStatus?.wallet ?? {};
    const tls = securityStatus?.tls ?? {};
    const activeUrl =
      mergedStatus?.activeStartup && mergedStatus.activeStartup.hostname
        ? buildEditorUrl(mergedStatus.activeStartup)
        : window.location.href;
    const restartUrl =
      mergedStatus?.restartUrl ??
      buildEditorUrl(runtimeSettingsCache ?? getRuntimeSettingsFallback());
    const walletSummary =
      wallet?.enabled
        ? [
            wallet.signingFingerprint ? `sign ${wallet.signingFingerprint}` : null,
            wallet.encryptionFingerprint ? `enc ${wallet.encryptionFingerprint}` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Wallet provisioning is disabled.";
    const tlsSummary =
      tls?.enabled
        ? formatStatusList([...(tls.dnsNames ?? []), ...(tls.ipAddresses ?? [])])
        : "Switch the protocol to HTTPS to generate a trusted local certificate.";

    setSecurityStatusValue(root, "#sdn-flow-security-active-url", activeUrl);
    setSecurityStatusValue(root, "#sdn-flow-security-restart-url", restartUrl);
    setSecurityStatusValue(root, "#sdn-flow-security-wallet-path", wallet.recordPath);
    setSecurityStatusValue(root, "#sdn-flow-security-wallet-summary", walletSummary);
    setSecurityStatusValue(root, "#sdn-flow-security-cert-path", tls.certificatePath);
    setSecurityStatusValue(root, "#sdn-flow-security-trust-path", tls.trustCertificatePath);
    setSecurityStatusValue(root, "#sdn-flow-security-cert-names", tlsSummary);
    setSecurityStatusValue(root, "#sdn-flow-security-storage-path", securityStatus.storageDir);
  }

  function findSecurityDialog() {
    return document.getElementById("sdn-flow-security-dialog");
  }

  function readRuntimeSettingsForm(root) {
    return normalizeRuntimeSettings(
      {
        protocol: root.querySelector("#sdn-flow-runtime-protocol")?.value,
        hostname: root.querySelector("#sdn-flow-runtime-hostname")?.value,
        port: root.querySelector("#sdn-flow-runtime-port")?.value,
        basePath: root.querySelector("#sdn-flow-runtime-base-path")?.value,
        title: root.querySelector("#sdn-flow-runtime-title")?.value,
        artifactArchiveLimit:
          root.querySelector("#sdn-flow-runtime-archive-retention")?.value,
        security: {
          storageDir: root.querySelector("#sdn-flow-runtime-security-dir")?.value,
        },
      },
      runtimeSettingsCache ?? getRuntimeSettingsFallback(),
    );
  }

  function fillRuntimeSettingsForm(root, settings) {
    const normalized = normalizeRuntimeSettings(
      settings,
      runtimeSettingsCache ?? getRuntimeSettingsFallback(),
    );
    root.querySelector("#sdn-flow-runtime-protocol").value = normalized.protocol;
    root.querySelector("#sdn-flow-runtime-hostname").value = normalized.hostname;
    root.querySelector("#sdn-flow-runtime-port").value = normalized.port;
    root.querySelector("#sdn-flow-runtime-base-path").value = normalized.basePath;
    root.querySelector("#sdn-flow-runtime-title").value = normalized.title;
    root.querySelector("#sdn-flow-runtime-archive-retention").value =
      normalized.artifactArchiveLimit;
    root.querySelector("#sdn-flow-runtime-security-dir").value =
      normalized.security.storageDir;
  }

  async function saveRuntimeSettings(settings, options = {}) {
    const normalized = normalizeRuntimeSettings(
      settings,
      runtimeSettingsCache ?? getRuntimeSettingsFallback(),
    );
    runtimeSettingsCache = normalized;
    const result = await fetchJson("api/runtime-settings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(normalized),
    });
    runtimeSettingsCache = normalizeRuntimeSettings(
      {
        ...(result?.startup ?? normalized),
        artifactArchiveLimit:
          result?.artifactArchiveLimit ?? normalized.artifactArchiveLimit,
        security: result?.security ?? normalized.security,
      },
      normalized,
    );
    runtimeStatusCache = mergeRuntimeStatus(result);
    window.__sdnFlowDesiredRestartUrl =
      result?.restartUrl ?? buildEditorUrl(runtimeSettingsCache);
    renderSecurityStatus(findSecurityDialog(), runtimeStatusCache);
    if (options.notify && window.RED?.notify) {
      RED.notify("Wallet and runtime settings saved. Compile to apply.", "success");
    }
    return result;
  }

  function closeSecurityDialog() {
    const dialog = findSecurityDialog();
    if (!dialog) {
      return;
    }
    dialog.hidden = true;
    document.body.classList.remove("sdn-flow-modal-open");
  }

  async function openSecurityDialog() {
    const dialog = ensureSecurityDialog();
    dialog.hidden = false;
    document.body.classList.add("sdn-flow-modal-open");
    fillRuntimeSettingsForm(dialog, runtimeSettingsCache ?? getRuntimeSettingsFallback());
    renderSecurityStatus(dialog, runtimeStatusCache);
    try {
      const runtimeSettings = await fetchJson("api/runtime-settings");
      runtimeSettingsCache = normalizeRuntimeSettings(
        {
          ...(runtimeSettings?.startup ?? {}),
          artifactArchiveLimit:
            runtimeSettings?.artifactArchiveLimit ??
            runtimeSettingsCache?.artifactArchiveLimit,
          security: runtimeSettings?.security,
        },
        runtimeSettingsCache ?? getRuntimeSettingsFallback(),
      );
      runtimeStatusCache = mergeRuntimeStatus(runtimeSettings);
      fillRuntimeSettingsForm(dialog, runtimeSettingsCache);
      renderSecurityStatus(dialog, runtimeStatusCache);
    } catch (error) {
      if (window.RED?.notify) {
        RED.notify(String(error?.message || error), "error");
      }
    }
  }

  function ensureSecurityDialog() {
    let dialog = findSecurityDialog();
    if (dialog) {
      return dialog;
    }
    dialog = document.createElement("div");
    dialog.id = "sdn-flow-security-dialog";
    dialog.className = "sdn-flow-security-dialog";
    dialog.hidden = true;
    dialog.innerHTML = `
      <div class="sdn-flow-security-backdrop" data-action="close"></div>
      <div class="sdn-flow-security-card" role="dialog" aria-modal="true" aria-labelledby="sdn-flow-security-title">
        <div class="sdn-flow-security-header">
          <div>
            <div id="sdn-flow-security-title" class="sdn-flow-security-title">Wallet & HTTPS</div>
            <div class="sdn-flow-security-subtitle">
              Runtime changes apply after the next compiled restart. HTTPS certificates are generated immediately so the trust path is ready before you restart.
            </div>
          </div>
          <button type="button" class="sdn-flow-security-close" data-action="close" aria-label="Close Wallet and HTTPS settings">
            <i class="fa fa-times" aria-hidden="true"></i>
          </button>
        </div>
        <div class="sdn-flow-security-body">
          <section class="sdn-flow-security-section">
            <div class="sdn-flow-security-section-title">Runtime</div>
            <div class="sdn-flow-security-grid">
              <label class="sdn-flow-security-field">
                <span>Protocol</span>
                <select id="sdn-flow-runtime-protocol">
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                </select>
              </label>
              <label class="sdn-flow-security-field">
                <span>Hostname</span>
                <input id="sdn-flow-runtime-hostname" type="text">
              </label>
              <label class="sdn-flow-security-field">
                <span>Port</span>
                <input id="sdn-flow-runtime-port" type="number">
              </label>
              <label class="sdn-flow-security-field">
                <span>Web Server Path</span>
                <input id="sdn-flow-runtime-base-path" type="text">
              </label>
              <label class="sdn-flow-security-field">
                <span>Window Title</span>
                <input id="sdn-flow-runtime-title" type="text">
              </label>
              <label class="sdn-flow-security-field">
                <span>Archive Retention</span>
                <input id="sdn-flow-runtime-archive-retention" type="number">
              </label>
              <label class="sdn-flow-security-field sdn-flow-security-field-wide">
                <span>Managed Storage Directory</span>
                <input id="sdn-flow-runtime-security-dir" type="text" placeholder="~/.sdn-flow">
              </label>
            </div>
          </section>
          <section class="sdn-flow-security-section">
            <div class="sdn-flow-security-section-title">Status</div>
            <div class="sdn-flow-security-status-grid">
              <div class="sdn-flow-security-status-row">
                <span>Current listener</span>
                <code id="sdn-flow-security-active-url"></code>
              </div>
              <div class="sdn-flow-security-status-row">
                <span>Next restart</span>
                <code id="sdn-flow-security-restart-url"></code>
              </div>
              <div class="sdn-flow-security-status-row">
                <span>Wallet file</span>
                <code id="sdn-flow-security-wallet-path"></code>
              </div>
              <div class="sdn-flow-security-status-row">
                <span>Wallet summary</span>
                <code id="sdn-flow-security-wallet-summary"></code>
              </div>
              <div class="sdn-flow-security-status-row">
                <span>Certificate file</span>
                <code id="sdn-flow-security-cert-path"></code>
              </div>
              <div class="sdn-flow-security-status-row">
                <span>Trust import path</span>
                <code id="sdn-flow-security-trust-path"></code>
              </div>
              <div class="sdn-flow-security-status-row">
                <span>Certificate names</span>
                <code id="sdn-flow-security-cert-names"></code>
              </div>
              <div class="sdn-flow-security-status-row">
                <span>Managed storage</span>
                <code id="sdn-flow-security-storage-path"></code>
              </div>
            </div>
          </section>
        </div>
        <div class="sdn-flow-security-footer">
          <button type="button" class="red-ui-button" data-action="close">Close</button>
          <button type="button" id="sdn-flow-security-save" class="red-ui-button red-ui-button-primary">Save & Generate</button>
        </div>
      </div>
    `;
    dialog.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.dataset?.action;
      if (action === "close") {
        closeSecurityDialog();
      }
    });
    dialog.querySelector("#sdn-flow-security-save").addEventListener("click", async () => {
      try {
        await saveRuntimeSettings(readRuntimeSettingsForm(dialog), {
          notify: true,
        });
      } catch (error) {
        if (window.RED?.notify) {
          RED.notify(String(error?.message || error), "error");
        }
      }
    });
    document.body.appendChild(dialog);
    return dialog;
  }

  function ensureSecurityToolbarButton() {
    if (securityPopupReady) {
      return;
    }
    const toolbar = document.querySelector(".red-ui-header-toolbar");
    if (!toolbar) {
      return;
    }
    securityPopupReady = true;
    const item = document.createElement("li");
    item.innerHTML = `
      <button id="sdn-flow-security-button" class="red-ui-button sdn-flow-security-button" type="button">
        <i class="fa fa-shield"></i>
        <span>Wallet & HTTPS</span>
      </button>
    `;
    toolbar.prepend(item);
    item.querySelector("#sdn-flow-security-button")?.addEventListener("click", () => {
      void openSecurityDialog();
    });
    ensureSecurityDialog();
  }

  function installSecurityPopup() {
    ensureSecurityToolbarButton();
  }

  function wireCompileWatcher() {
    if (!window.jQuery || window.__sdnFlowCompileWatcherInstalled) {
      return;
    }
    window.__sdnFlowCompileWatcherInstalled = true;
    $(document).ajaxSuccess((event, xhr) => {
      const compilePending = xhr.getResponseHeader("x-sdn-flow-compile-pending");
      if (compilePending !== "1") {
        return;
      }
      const restartPending = xhr.getResponseHeader("x-sdn-flow-restart-pending");
      const restartUrl = resolveRestartUrl(xhr);
      if (restartUrl) {
        window.__sdnFlowDesiredRestartUrl = restartUrl;
      }
      const previousRuntimeId = window.__sdnFlowRuntimeId;
      const message =
        restartPending === "1"
          ? restartUrl
            ? `A new editor executable has been built. Waiting for restart at ${restartUrl}...`
            : "A new editor executable has been built. Waiting for restart..."
          : "Compiling flow artifacts and updating the standalone executable...";
      showCompileOverlay(message);
      pollForCompile(previousRuntimeId, restartUrl, restartPending === "1");
    });
    $(document).ajaxError(() => {
      hideCompileOverlay();
    });
  }

  function bootWhenReady() {
    const start = () => {
      overrideTranslations();
      wireCompileWatcher();
      installBranding();
      installDeployMenuUi();
      installDocumentationPruner();
      ensureConnectionIndicator();
      installArchiveTab();
      installCompilePreviewTab();
      installSecurityPopup();
      startRuntimePolling();
    };

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      installCommsBridge();
      installBranding();
      installDeployMenuUi();
      installDocumentationPruner();
      if (window.RED?.sidebar?.addTab) {
        clearInterval(timer);
        start();
      } else if (attempts > 200) {
        clearInterval(timer);
      }
    }, 100);
  }

  installCommsBridge();
  bootWhenReady();
})();
