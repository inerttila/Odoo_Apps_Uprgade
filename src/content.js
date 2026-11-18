(() => {
  const CHANNEL = "odoo-oneclick-upgrade";
  const ROOT_ID = "odoo-oneclick-upgrade-root";
  const POSITION_KEY = "odooUpgradeButtonPosition";
  const ENABLED_KEY = "odooUpgradeEnabled";
  const DRAG_THRESHOLD = 5;
  const SEARCH_MIN_CHARS = 2;
  const SEARCH_DEBOUNCE_MS = 220;

  let pageReady = false;
  let extensionEnabled = true;
  let detecting = false;
  let upgrading = false;
  let suppressClick = false;
  let savedPosition = null;
  let state = {
    active: false,
    bestGuess: null,
    selected: null,
    candidates: [],
    context: null,
    message: "",
  };
  let toastTimer = null;
  let detectTimer = null;
  let searchTimer = null;
  let searchSeq = 0;
  let searchQuery = "";
  let searchResults = [];
  let searchLoading = false;
  let searchError = "";
  let searchHighlight = -1;

  const pending = new Map();
  let contextDead = false;

  function isExtensionAlive() {
    try {
      return Boolean(chrome?.runtime?.id) && !contextDead;
    } catch (_err) {
      contextDead = true;
      return false;
    }
  }

  function markContextDead(err) {
    const message = err?.message || String(err || "");
    if (!/Extension context invalidated/i.test(message)) return false;
    contextDead = true;
    try {
      showToast("Extension was reloaded — refresh this Odoo tab", "error");
    } catch (_err) {
      // UI may not exist yet
    }
    return true;
  }

  async function storageGet(keys) {
    if (!isExtensionAlive()) return {};
    try {
      return await chrome.storage.local.get(keys);
    } catch (err) {
      markContextDead(err);
      return {};
    }
  }

  async function storageSet(values) {
    if (!isExtensionAlive()) return;
    try {
      await chrome.storage.local.set(values);
    } catch (err) {
      markContextDead(err);
    }
  }

  function notifyBackground(message) {
    if (!isExtensionAlive()) return;
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") {
        result.catch((err) => markContextDead(err));
      }
    } catch (err) {
      markContextDead(err);
    }
  }

  function askPage(action, payload = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Timed out talking to Odoo page script"));
      }, 20000);

      pending.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      window.postMessage(
        {
          source: CHANNEL,
          direction: "content-to-page",
          requestId,
          action,
          payload,
        },
        "*",
      );
    });
  }

  function injectPageScript() {
    if (document.documentElement.dataset.oouInjected === "1") return;
    if (!isExtensionAlive()) return;
    try {
      document.documentElement.dataset.oouInjected = "1";
      const script = document.createElement("script");
      script.src = chrome.runtime.getURL("src/page.js");
      script.async = false;
      script.onload = () => script.remove();
      (document.head || document.documentElement).appendChild(script);
    } catch (err) {
      markContextDead(err);
      delete document.documentElement.dataset.oouInjected;
    }
  }

  function ensureUi() {
    let root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.innerHTML = `
      <div class="oou-panel">
        <div class="oou-bar">
          <button type="button" class="oou-main">Upgrade…</button>
          <button type="button" class="oou-toggle" title="Pick another module">▾</button>
        </div>
        <div class="oou-toast" hidden></div>
        <div class="oou-confirm">
          <p class="oou-confirm-text"></p>
          <div class="oou-confirm-actions">
            <button type="button" class="oou-cancel">Cancel</button>
            <button type="button" class="oou-ok">Upgrade</button>
          </div>
        </div>
        <div class="oou-picker">
          <h3>Choose module to upgrade</h3>
          <div class="oou-manual">
            <input
              type="text"
              class="oou-manual-input"
              placeholder="Search installed module…"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="button" class="oou-manual-go">Use</button>
          </div>
          <p class="oou-hint"></p>
          <ul class="oou-list"></ul>
        </div>
      </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector(".oou-main").addEventListener("click", (ev) => {
      if (suppressClick) {
        suppressClick = false;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      onMainClick();
    });
    root.querySelector(".oou-toggle").addEventListener("click", (ev) => {
      if (suppressClick) {
        suppressClick = false;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      onToggleClick();
    });
    root.querySelector(".oou-cancel").addEventListener("click", () => setConfirmOpen(false));
    root.querySelector(".oou-ok").addEventListener("click", onConfirmUpgrade);
    root.querySelector(".oou-manual-go").addEventListener("click", onManualUse);
    const manualInput = root.querySelector(".oou-manual-input");
    manualInput.addEventListener("input", onManualInput);
    manualInput.addEventListener("keydown", onManualKeydown);
    enableDragging(root);
    applySavedPosition(root);

    return root;
  }

  function clampPosition(left, top, root) {
    const bar = root.querySelector(".oou-bar");
    const rect = (bar || root).getBoundingClientRect();
    const width = rect.width || 180;
    const height = rect.height || 44;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - height - 8);
    return {
      left: Math.min(Math.max(8, left), maxLeft),
      top: Math.min(Math.max(8, top), maxTop),
    };
  }

  function applyPosition(root, left, top, { repositionOverlays = true } = {}) {
    const pos = clampPosition(left, top, root);
    root.classList.add("is-placed");
    root.style.left = `${pos.left}px`;
    root.style.top = `${pos.top}px`;
    root.style.right = "auto";
    savedPosition = pos;
    if (repositionOverlays) {
      const picker = root.querySelector(".oou-picker.is-open");
      const confirm = root.querySelector(".oou-confirm.is-open");
      if (picker) placeOverlay(picker);
      if (confirm) placeOverlay(confirm);
    }
    return pos;
  }

  function applySavedPosition(root) {
    if (!savedPosition) return;
    applyPosition(root, savedPosition.left, savedPosition.top);
  }

  function placeOverlay(el) {
    if (!el || !el.classList.contains("is-open")) return;

    const root = ensureUi();
    const bar = root.querySelector(".oou-bar");
    const barRect = bar.getBoundingClientRect();
    const margin = 8;
    const gap = 8;

    // Prefer below the button; flip above when there isn't enough room.
    const spaceBelow = window.innerHeight - barRect.bottom - margin;
    const spaceAbove = barRect.top - margin;
    const estimatedHeight = Math.min(
      el.scrollHeight || 220,
      Math.max(120, window.innerHeight - margin * 2),
    );
    const placeBelow = spaceBelow >= Math.min(estimatedHeight, 160) || spaceBelow >= spaceAbove;

    el.classList.toggle("oou-place-below", placeBelow);
    el.classList.toggle("oou-place-above", !placeBelow);

    // Cap height to the available side so content scrolls instead of clipping.
    const available = Math.max(120, placeBelow ? spaceBelow - gap : spaceAbove - gap);
    el.style.maxHeight = `${Math.min(360, available)}px`;

    // Keep the floating button itself fully on-screen (overlays are absolute).
    const rootRect = root.getBoundingClientRect();
    applyPosition(root, rootRect.left, rootRect.top, { repositionOverlays: false });

    // Nudge horizontally if the overlay would overflow the viewport.
    requestAnimationFrame(() => {
      const overlayRect = el.getBoundingClientRect();
      let shiftX = 0;
      if (overlayRect.right > window.innerWidth - margin) {
        shiftX = overlayRect.right - (window.innerWidth - margin);
      } else if (overlayRect.left < margin) {
        shiftX = overlayRect.left - margin;
      }
      if (shiftX !== 0) {
        const next = root.getBoundingClientRect();
        applyPosition(root, next.left - shiftX, next.top, { repositionOverlays: false });
      }
    });
  }

  function placeOpenOverlays() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    placeOverlay(root.querySelector(".oou-picker"));
    placeOverlay(root.querySelector(".oou-confirm"));
  }

  async function loadSavedPosition() {
    const data = await storageGet(POSITION_KEY);
    const pos = data[POSITION_KEY];
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      savedPosition = pos;
      const root = document.getElementById(ROOT_ID);
      if (root) applySavedPosition(root);
    }
  }

  async function persistPosition(pos) {
    savedPosition = pos;
    await storageSet({ [POSITION_KEY]: pos });
  }

  function enableDragging(root) {
    const bar = root.querySelector(".oou-bar");
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;

    const onMove = (ev) => {
      const point = ev.touches ? ev.touches[0] : ev;
      const dx = point.clientX - startX;
      const dy = point.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      moved = true;
      dragging = true;
      root.classList.add("is-dragging");
      applyPosition(root, originLeft + dx, originTop + dy, { repositionOverlays: false });
      if (ev.cancelable) ev.preventDefault();
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("touchmove", onMove, true);
      window.removeEventListener("touchend", onUp, true);
      root.classList.remove("is-dragging");
      if (moved) {
        suppressClick = true;
        const rect = root.getBoundingClientRect();
        persistPosition({ left: rect.left, top: rect.top });
        placeOpenOverlays();
      }
      dragging = false;
      moved = false;
    };

    const onDown = (ev) => {
      if (upgrading) return;
      if (ev.type === "mousedown" && ev.button !== 0) return;
      const point = ev.touches ? ev.touches[0] : ev;
      const rect = root.getBoundingClientRect();
      dragging = false;
      moved = false;
      suppressClick = false;
      startX = point.clientX;
      startY = point.clientY;
      originLeft = rect.left;
      originTop = rect.top;
      window.addEventListener("mousemove", onMove, true);
      window.addEventListener("mouseup", onUp, true);
      window.addEventListener("touchmove", onMove, { capture: true, passive: false });
      window.addEventListener("touchend", onUp, true);
    };

    bar.addEventListener("mousedown", onDown);
    bar.addEventListener("touchstart", onDown, { passive: true });
  }

  function setVisible(visible) {
    const show = Boolean(visible) && extensionEnabled;
    const root = show ? ensureUi() : document.getElementById(ROOT_ID);
    if (root) {
      root.style.display = show ? "" : "none";
      if (!show) {
        root.querySelector(".oou-picker")?.classList.remove("is-open");
        root.querySelector(".oou-confirm")?.classList.remove("is-open");
      }
    }
    notifyBackground({ type: "odoo_upgrade_status", active: show });
  }

  async function loadEnabled() {
    const data = await storageGet(ENABLED_KEY);
    extensionEnabled = data[ENABLED_KEY] !== false;
    return extensionEnabled;
  }

  function startWhenEnabled() {
    if (!extensionEnabled) return;
    injectPageScript();
    ensureUi();
    if (pageReady) scheduleDetect(50);
  }

  function stopWhenDisabled() {
    clearTimeout(detectTimer);
    clearTimeout(searchTimer);
    detecting = false;
    setVisible(false);
  }

  function applyEnabled(enabled) {
    const next = Boolean(enabled);
    if (extensionEnabled === next) {
      if (!next) stopWhenDisabled();
      return;
    }
    extensionEnabled = next;
    if (!extensionEnabled) {
      stopWhenDisabled();
      return;
    }
    startWhenEnabled();
  }

  function setLoading(isLoading) {
    const bar = ensureUi().querySelector(".oou-bar");
    bar.classList.toggle("is-loading", isLoading);
    bar.classList.toggle("is-disabled", isLoading);
    upgrading = isLoading;
  }

  function setPickerOpen(open) {
    const picker = ensureUi().querySelector(".oou-picker");
    picker.classList.toggle("is-open", open);
    if (open) {
      setConfirmOpen(false);
      placeOverlay(picker);
    } else {
      picker.classList.remove("oou-place-below", "oou-place-above");
      picker.style.maxHeight = "";
      resetSearch({ rerender: false });
    }
  }

  function setConfirmOpen(open, moduleName = "") {
    const confirm = ensureUi().querySelector(".oou-confirm");
    confirm.classList.toggle("is-open", open);
    if (open) {
      setPickerOpen(false);
      confirm.querySelector(".oou-confirm-text").textContent =
        `Upgrade module "${moduleName}"? This can reload the page.`;
      confirm.dataset.module = moduleName;
      placeOverlay(confirm);
    } else {
      delete confirm.dataset.module;
      confirm.classList.remove("oou-place-below", "oou-place-above");
      confirm.style.maxHeight = "";
    }
  }

  function showToast(message, kind = "info") {
    const root = ensureUi();
    const toast = root.querySelector(".oou-toast");
    const bar = root.querySelector(".oou-bar");
    const barRect = bar.getBoundingClientRect();
    const placeBelow = barRect.top < 72;
    toast.classList.toggle("oou-place-below", placeBelow);
    toast.classList.toggle("oou-place-above", !placeBelow);
    toast.hidden = false;
    toast.textContent = message;
    toast.classList.remove("is-visible", "is-error", "is-success");
    if (kind === "error") toast.classList.add("is-error");
    if (kind === "success") toast.classList.add("is-success");
    requestAnimationFrame(() => toast.classList.add("is-visible"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 4200);
  }

  function isSearchMode() {
    return searchQuery.length >= SEARCH_MIN_CHARS;
  }

  function visibleModules() {
    if (isSearchMode()) return searchResults;
    return state.candidates;
  }

  function render() {
    const root = ensureUi();
    const selected = state.selected || state.bestGuess;
    const main = root.querySelector(".oou-main");
    const hint = root.querySelector(".oou-hint");
    const list = root.querySelector(".oou-list");
    const searching = isSearchMode();
    const items = visibleModules();

    if (!state.active) {
      setVisible(false);
      return;
    }

    setVisible(true);
    main.textContent = selected ? `Upgrade ${selected}` : "Upgrade…";

    if (searching) {
      if (searchLoading) {
        hint.textContent = `Searching installed modules for “${searchQuery}”…`;
      } else if (searchError) {
        hint.textContent = searchError;
      } else {
        hint.textContent = items.length
          ? `Found ${items.length} installed module(s) for “${searchQuery}”`
          : `No installed module matches “${searchQuery}”`;
      }
    } else {
      hint.textContent = state.message || "Pick a module if the guess is wrong (custom inherit).";
    }

    list.innerHTML = "";
    if (searchLoading && searching) {
      const empty = document.createElement("li");
      empty.innerHTML = `<button type="button" disabled>Searching…</button>`;
      list.appendChild(empty);
    } else if (!items.length) {
      const empty = document.createElement("li");
      empty.innerHTML = `<button type="button" disabled>${
        searching ? "No installed modules found" : "No candidates detected"
      }</button>`;
      list.appendChild(empty);
    } else {
      items.forEach((item, index) => {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        const highlighted = searching && index === searchHighlight;
        const selectedCls = item.module === selected ? "is-selected" : "";
        btn.className = [selectedCls, highlighted ? "is-active" : ""].filter(Boolean).join(" ");
        const reason = searching
          ? `${item.displayName || ""} — installed`
          : `${item.displayName || ""} — ${item.reason || ""}`;
        btn.innerHTML = `<span>${escapeHtml(item.module)}</span><span class="oou-reason">${escapeHtml(
          reason,
        )}</span>`;
        btn.addEventListener("click", () => {
          useModuleName(item.module, item.displayName || item.module, searching ? "manual search" : item.reason || "detected");
        });
        li.appendChild(btn);
        list.appendChild(li);
      });
    }

    if (root.querySelector(".oou-picker.is-open")) {
      placeOpenOverlays();
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  async function detectNow() {
    if (!extensionEnabled || !pageReady || detecting || upgrading) return;
    detecting = true;
    try {
      const result = await askPage("detect");
      const candidates = result.candidates || [];
      state = {
        active: Boolean(result.active),
        bestGuess: result.bestGuess || null,
        selected: result.bestGuess || null,
        candidates,
        context: result.context || null,
        message: result.message || "",
      };
      render();
    } catch (err) {
      state.active = false;
      render();
      // Keep quiet on non-Odoo pages; only toast when UI was already active
    } finally {
      detecting = false;
    }
  }

  function scheduleDetect(delay = 250) {
    if (!extensionEnabled) return;
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      detectNow();
    }, delay);
  }

  function onMainClick() {
    if (!extensionEnabled || upgrading) return;
    const moduleName = state.selected || state.bestGuess;
    if (!moduleName) {
      setPickerOpen(true);
      return;
    }
    setConfirmOpen(true, moduleName);
  }

  function onToggleClick() {
    if (!extensionEnabled || upgrading) return;
    const picker = ensureUi().querySelector(".oou-picker");
    setPickerOpen(!picker.classList.contains("is-open"));
  }

  async function onConfirmUpgrade() {
    const confirm = ensureUi().querySelector(".oou-confirm");
    const moduleName = confirm.dataset.module;
    if (!moduleName || upgrading) return;
    setConfirmOpen(false);
    setLoading(true);
    mainLabel(`Upgrading ${moduleName}…`);
    try {
      await askPage("upgrade", { module: moduleName });
      showToast(`Upgraded ${moduleName}`, "success");
      mainLabel(`Upgrade ${moduleName}`);
    } catch (err) {
      showToast(err?.message || String(err), "error");
      mainLabel(state.selected || state.bestGuess ? `Upgrade ${state.selected || state.bestGuess}` : "Upgrade…");
    } finally {
      setLoading(false);
      scheduleDetect(1000);
    }
  }

  function mainLabel(text) {
    ensureUi().querySelector(".oou-main").textContent = text;
  }

  function resetSearch({ rerender = true } = {}) {
    searchQuery = "";
    searchResults = [];
    searchHighlight = -1;
    searchLoading = false;
    searchError = "";
    clearTimeout(searchTimer);
    searchSeq += 1;
    const input = document.getElementById(ROOT_ID)?.querySelector(".oou-manual-input");
    if (input) input.value = "";
    if (rerender) render();
  }

  function useModuleName(moduleName, displayName = moduleName, reason = "manual entry") {
    const value = (moduleName || "").trim();
    if (!value) {
      showToast("Enter a technical module name", "error");
      return;
    }
    state.selected = value;
    if (!state.candidates.some((c) => c.module === value)) {
      state.candidates = [
        {
          module: value,
          displayName,
          reason,
          source: "manual",
          score: 0,
        },
        ...state.candidates,
      ];
    }
    resetSearch({ rerender: false });
    render();
    setPickerOpen(false);
    setConfirmOpen(true, value);
  }

  function onManualInput(ev) {
    const query = (ev.target.value || "").trim();
    searchQuery = query;
    clearTimeout(searchTimer);
    searchHighlight = -1;
    searchError = "";

    if (query.length < SEARCH_MIN_CHARS) {
      searchResults = [];
      searchLoading = false;
      searchSeq += 1;
      render();
      return;
    }

    searchLoading = true;
    render();

    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      try {
        const results = await askPage("searchModules", { query });
        if (seq !== searchSeq) return;
        searchResults = Array.isArray(results) ? results : [];
        searchLoading = false;
        searchError = "";
        searchHighlight = searchResults.length ? 0 : -1;
        render();
      } catch (err) {
        if (seq !== searchSeq) return;
        searchResults = [];
        searchLoading = false;
        searchError = err?.message || "Search failed";
        searchHighlight = -1;
        render();
      }
    }, SEARCH_DEBOUNCE_MS);
  }

  function onManualKeydown(ev) {
    const items = visibleModules();
    const listVisible = isSearchMode() && items.length > 0;

    if (ev.key === "ArrowDown" && listVisible) {
      ev.preventDefault();
      searchHighlight = (searchHighlight + 1) % items.length;
      render();
      return;
    }
    if (ev.key === "ArrowUp" && listVisible) {
      ev.preventDefault();
      searchHighlight = searchHighlight <= 0 ? items.length - 1 : searchHighlight - 1;
      render();
      return;
    }
    if (ev.key === "Escape") {
      if (isSearchMode() || searchQuery) {
        ev.preventDefault();
        resetSearch();
      }
      return;
    }
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (listVisible && searchHighlight >= 0 && items[searchHighlight]) {
        const item = items[searchHighlight];
        useModuleName(item.module, item.displayName || item.module, "manual search");
        return;
      }
      onManualUse();
    }
  }

  function onManualUse() {
    const input = ensureUi().querySelector(".oou-manual-input");
    const value = (input.value || "").trim();
    if (isSearchMode() && searchResults.length === 1) {
      const item = searchResults[0];
      useModuleName(item.module, item.displayName || item.module, "manual search");
      return;
    }
    if (isSearchMode() && searchHighlight >= 0 && searchResults[searchHighlight]) {
      const item = searchResults[searchHighlight];
      useModuleName(item.module, item.displayName || item.module, "manual search");
      return;
    }
    useModuleName(value);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.direction !== "page-to-content") return;

    if (data.action === "ready") {
      pageReady = true;
      if (extensionEnabled && data.result?.active) {
        setVisible(true);
        scheduleDetect(100);
      } else {
        setVisible(false);
      }
      return;
    }

    if (!data.requestId || !pending.has(data.requestId)) return;
    const entry = pending.get(data.requestId);
    pending.delete(data.requestId);
    if (data.ok) entry.resolve(data.result);
    else entry.reject(new Error(data.error || "Unknown page error"));
  });

  if (typeof chrome?.runtime?.onMessage?.addListener === "function") {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "odoo_upgrade_set_enabled") {
        applyEnabled(message.enabled !== false);
        sendResponse({ ok: true });
        return true;
      }
      return false;
    });
  }

  if (typeof chrome?.storage?.onChanged?.addListener === "function") {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[ENABLED_KEY]) return;
      applyEnabled(changes[ENABLED_KEY].newValue !== false);
    });
  }

  // SPA navigation in Odoo backend (hash router + occasional history API)
  window.addEventListener("hashchange", () => {
    if (extensionEnabled) scheduleDetect(200);
  });
  window.addEventListener("popstate", () => {
    if (extensionEnabled) scheduleDetect(200);
  });

  let lastHref = location.href;
  setInterval(() => {
    if (!extensionEnabled) {
      lastHref = location.href;
      return;
    }
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleDetect(200);
    }
  }, 700);

  loadSavedPosition();
  loadEnabled().then((enabled) => {
    if (!enabled) {
      stopWhenDisabled();
      return;
    }
    startWhenEnabled();
  });

  window.addEventListener("resize", () => {
    if (!extensionEnabled) return;
    const root = document.getElementById(ROOT_ID);
    if (!root) return;
    if (savedPosition) applySavedPosition(root);
    else {
      const rect = root.getBoundingClientRect();
      applyPosition(root, rect.left, rect.top);
    }
    placeOpenOverlays();
  });

  // Retry detect a few times while OWL boots (only while enabled)
  let boots = 0;
  const bootTimer = setInterval(() => {
    boots += 1;
    if (extensionEnabled && pageReady) scheduleDetect(0);
    if (boots >= 20) clearInterval(bootTimer);
  }, 500);
})();
