(() => {
  const CHANNEL = "odoo-oneclick-upgrade";
  const WEAK_MODULES = new Set([
    "base",
    "web",
    "web_editor",
    "web_tour",
    "web_enterprise",
    "mail",
    "bus",
    "html_editor",
    "http_routing",
    "auth_signup",
    "portal",
    "website",
  ]);

  function reply(requestId, payload) {
    window.postMessage(
      {
        source: CHANNEL,
        direction: "page-to-content",
        requestId,
        ...payload,
      },
      "*",
    );
  }

  function getHashParams() {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = {};
    for (const part of hash.split("&")) {
      if (!part) continue;
      const [rawKey, rawVal = ""] = part.split("=");
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal);
    }
    return params;
  }

  function getOdooRoot() {
    if (window.odoo?.__WOWL_DEBUG__?.root) {
      return window.odoo.__WOWL_DEBUG__.root;
    }
    return null;
  }

  function getServices() {
    const root = getOdooRoot();
    return root?.env?.services || null;
  }

  function isOdooBackend() {
    if (!window.odoo) return false;
    const services = getServices();
    if (services?.action || services?.orm || services?.rpc) return true;
    // Backend shell marker used by Odoo web client
    if (document.querySelector(".o_web_client, .o_action_manager, .o_main_navbar")) {
      return true;
    }
    return Boolean(window.odoo.__WOWL_DEBUG__ || window.odoo.info || window.odoo.session_info);
  }

  async function rpcCallFetch(model, method, args = [], kwargs = {}) {
    const response = await fetch(`/web/dataset/call_kw/${model}/${method}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        params: {
          model,
          method,
          args,
          kwargs,
        },
        id: Date.now(),
      }),
    });

    const data = await response.json();
    if (data.error) {
      const message =
        data.error.data?.message ||
        data.error.message ||
        "Odoo RPC error";
      throw new Error(message);
    }
    return data.result;
  }

  async function rpcCall(model, method, args = [], kwargs = {}) {
    const services = getServices();

    if (services?.orm?.call) {
      return services.orm.call(model, method, args, kwargs);
    }

    if (services?.rpc) {
      return services.rpc(`/web/dataset/call_kw/${model}/${method}`, {
        model,
        method,
        args,
        kwargs,
      });
    }

    return rpcCallFetch(model, method, args, kwargs);
  }

  async function searchRead(model, domain, fields, kwargs = {}) {
    const services = getServices();
    if (services?.orm?.searchRead) {
      return services.orm.searchRead(model, domain, fields, kwargs);
    }
    // call_kw search_read signature: args = [domain], kwargs = { fields, ... }
    return rpcCall(model, "search_read", [domain], { fields, ...kwargs });
  }

  function getControllerInfo() {
    const services = getServices();
    const controller = services?.action?.currentController || null;
    const hash = getHashParams();

    const actionId =
      controller?.action?.id ??
      (hash.action && !Number.isNaN(Number(hash.action)) ? Number(hash.action) : null);
    const menuId =
      (hash.menu_id && !Number.isNaN(Number(hash.menu_id)) ? Number(hash.menu_id) : null) ??
      controller?.action?.menuID ??
      null;
    const resModel = controller?.props?.resModel || hash.model || null;
    const viewId =
      (typeof controller?.view?.id === "number" ? controller.view.id : null) ||
      (hash.view_id && !Number.isNaN(Number(hash.view_id)) ? Number(hash.view_id) : null);
    const viewType = controller?.view?.type || hash.view_type || null;

    return {
      actionId,
      menuId,
      resModel,
      viewId,
      viewType,
      actionName: controller?.action?.name || null,
    };
  }

  async function modulesForRecords(model, resIds) {
    const ids = [...new Set(resIds.filter((id) => typeof id === "number" && id > 0))];
    if (!ids.length) return [];

    const rows = await searchRead(
      "ir.model.data",
      [
        ["model", "=", model],
        ["res_id", "in", ids],
      ],
      ["module", "name", "res_id"],
      { limit: 50 },
    );

    return rows.map((row) => ({
      module: row.module,
      xmlid: `${row.module}.${row.name}`,
      resId: row.res_id,
      model,
    }));
  }

  function scoreCandidate(candidate, hasStrongCustom) {
    let score = candidate.baseScore;
    if (WEAK_MODULES.has(candidate.module)) {
      score -= hasStrongCustom ? 40 : 10;
    } else {
      score += 15;
    }
    return score;
  }

  async function resolveCandidates() {
    if (!isOdooBackend()) {
      return {
        active: false,
        bestGuess: null,
        candidates: [],
        context: null,
        message: "Not an Odoo backend page",
      };
    }

    const info = getControllerInfo();
    const discovered = [];

    if (info.menuId) {
      const menuMods = await modulesForRecords("ir.ui.menu", [info.menuId]);
      for (const item of menuMods) {
        discovered.push({
          module: item.module,
          reason: `menu ${item.xmlid}`,
          source: "menu",
          baseScore: 100,
        });
      }
    }

    if (info.actionId) {
      const actionModels = [
        "ir.actions.act_window",
        "ir.actions.client",
        "ir.actions.server",
        "ir.actions.report",
      ];
      for (const model of actionModels) {
        const actionMods = await modulesForRecords(model, [info.actionId]);
        for (const item of actionMods) {
          discovered.push({
            module: item.module,
            reason: `action ${item.xmlid}`,
            source: "action",
            baseScore: 85,
          });
        }
        if (actionMods.length) break;
      }
    }

    // Current view + inherits that apply to THIS view
    if (info.viewId) {
      const viewMods = await modulesForRecords("ir.ui.view", [info.viewId]);
      for (const item of viewMods) {
        discovered.push({
          module: item.module,
          reason: `view ${item.xmlid}`,
          source: "view",
          baseScore: 70,
        });
      }

      try {
        const relatedViews = await searchRead(
          "ir.ui.view",
          ["|", ["id", "=", info.viewId], ["inherit_id", "child_of", info.viewId]],
          ["id", "name", "inherit_id"],
          { limit: 80 },
        );
        const relatedIds = relatedViews.map((v) => v.id).filter((id) => id !== info.viewId);
        const inheritMods = await modulesForRecords("ir.ui.view", relatedIds);
        for (const item of inheritMods) {
          discovered.push({
            module: item.module,
            reason: `inherit ${item.xmlid}`,
            source: "inherit",
            baseScore: WEAK_MODULES.has(item.module) ? 55 : 80,
          });
        }
      } catch (_err) {
        // Non-fatal: some DBs/ACL setups may reject child_of on views
      }
    }

    // Custom modules that inherit views on this model (e.g. abi_hr_holidays on hr.leave)
    if (info.resModel) {
      try {
        const modelInherits = await searchRead(
          "ir.ui.view",
          [
            ["model", "=", info.resModel],
            ["inherit_id", "!=", false],
          ],
          ["id"],
          { limit: 100, order: "id desc" },
        );
        const inheritMods = await modulesForRecords(
          "ir.ui.view",
          modelInherits.map((v) => v.id),
        );
        for (const item of inheritMods) {
          if (WEAK_MODULES.has(item.module)) continue;
          discovered.push({
            module: item.module,
            reason: `model inherit ${item.xmlid}`,
            source: "inherit",
            baseScore: 78,
          });
        }
      } catch (_err) {
        // Non-fatal
      }
    }

    const byModule = new Map();
    function upsertDiscovered(item) {
      if (!item.module) return;
      const existing = byModule.get(item.module);
      if (!existing || item.baseScore > existing.baseScore) {
        byModule.set(item.module, { ...item });
      } else if (existing && !existing.reason.includes(item.reason)) {
        existing.reason = `${existing.reason}; ${item.reason}`;
      }
    }
    for (const item of discovered) upsertDiscovered(item);

    // Installed modules that depend on the detected ones (hr_holidays → abi_hr_holidays)
    const baseNames = [...byModule.keys()];
    if (baseNames.length) {
      try {
        const depRows = await searchRead(
          "ir.module.module.dependency",
          [["name", "in", baseNames]],
          ["name", "module_id"],
          { limit: 120 },
        );
        const dependentIds = [
          ...new Set(
            depRows
              .map((row) => (Array.isArray(row.module_id) ? row.module_id[0] : null))
              .filter((id) => typeof id === "number"),
          ),
        ];
        if (dependentIds.length) {
          const dependentMods = await searchRead(
            "ir.module.module",
            [
              ["id", "in", dependentIds],
              ["state", "in", ["installed", "to upgrade"]],
            ],
            ["id", "name", "shortdesc", "state"],
            { limit: 120 },
          );
          const idToDepName = new Map(
            depRows.map((row) => [
              Array.isArray(row.module_id) ? row.module_id[0] : null,
              row.name,
            ]),
          );
          for (const mod of dependentMods) {
            if (byModule.has(mod.name)) continue;
            const base = idToDepName.get(mod.id) || "detected module";
            upsertDiscovered({
              module: mod.name,
              reason: `depends on ${base}`,
              source: "dependency",
              baseScore: WEAK_MODULES.has(mod.name) ? 50 : 90,
            });
          }
        }
      } catch (_err) {
        // Non-fatal: dependency model may be restricted
      }

      // Fallback: installed modules whose technical name contains the base module
      // e.g. abi_hr_holidays for hr_holidays (skips exact base name)
      try {
        for (const base of baseNames.slice(0, 5)) {
          if (!base || base.length < 3) continue;
          const named = await searchRead(
            "ir.module.module",
            [
              ["name", "ilike", base],
              ["name", "!=", base],
              ["state", "in", ["installed", "to upgrade"]],
            ],
            ["id", "name", "shortdesc", "state"],
            { limit: 30 },
          );
          for (const mod of named) {
            // Prefer real extensions: name contains base as a segment
            const isExtension =
              mod.name.includes(`_${base}`) ||
              mod.name.includes(`${base}_`) ||
              mod.name.endsWith(base);
            if (!isExtension) continue;
            upsertDiscovered({
              module: mod.name,
              reason: `extends ${base}`,
              source: "extension",
              baseScore: WEAK_MODULES.has(mod.name) ? 45 : 88,
            });
          }
        }
      } catch (_err) {
        // Non-fatal
      }
    }

    const names = [...byModule.keys()];
    let installed = [];
    if (names.length) {
      installed = await searchRead(
        "ir.module.module",
        [
          ["name", "in", names],
          ["state", "in", ["installed", "to upgrade"]],
        ],
        ["id", "name", "shortdesc", "state"],
        { limit: 100 },
      );
    }

    const installedMap = new Map(installed.map((m) => [m.name, m]));
    const hasStrongCustom = [...byModule.keys()].some((name) => !WEAK_MODULES.has(name));

    const candidates = [...byModule.values()]
      .filter((c) => installedMap.has(c.module))
      .map((c) => {
        const mod = installedMap.get(c.module);
        return {
          module: c.module,
          moduleId: mod.id,
          displayName: mod.shortdesc || c.module,
          state: mod.state,
          reason: c.reason,
          source: c.source,
          score: scoreCandidate(c, hasStrongCustom),
        };
      })
      .sort((a, b) => b.score - a.score || a.module.localeCompare(b.module));

    return {
      active: true,
      bestGuess: candidates[0]?.module || null,
      candidates,
      context: info,
      message: candidates.length
        ? `Detected ${candidates.length} candidate(s)`
        : "No module candidate found for this view",
    };
  }

  async function upgradeModule(moduleName) {
    if (!moduleName || typeof moduleName !== "string") {
      throw new Error("Module technical name is required");
    }

    const rows = await searchRead(
      "ir.module.module",
      [["name", "=", moduleName]],
      ["id", "name", "state", "shortdesc"],
      { limit: 1 },
    );

    if (!rows.length) {
      throw new Error(`Module "${moduleName}" was not found`);
    }

    const mod = rows[0];
    if (!["installed", "to upgrade"].includes(mod.state)) {
      throw new Error(`Module "${moduleName}" is not installed (state: ${mod.state})`);
    }

    await rpcCall("ir.module.module", "button_immediate_upgrade", [[mod.id]], {});

    return {
      module: mod.name,
      moduleId: mod.id,
      displayName: mod.shortdesc || mod.name,
    };
  }

  async function searchModules(query) {
    const q = String(query || "").trim();
    if (q.length < 2) return [];

    const domain = [
      "&",
      ["state", "in", ["installed", "to upgrade"]],
      "|",
      ["name", "ilike", q],
      ["shortdesc", "ilike", q],
    ];
    const rows = await searchRead("ir.module.module", domain, ["id", "name", "shortdesc", "state"], {
      limit: 25,
      order: "name asc",
    });

    const needle = q.toLowerCase();
    return rows
      .map((m) => {
        const name = String(m.name || "").toLowerCase();
        const label = String(m.shortdesc || "").toLowerCase();
        let score = 0;
        if (name === needle) score += 100;
        else if (name.startsWith(needle)) score += 70;
        else if (name.includes(needle)) score += 40;
        if (label.includes(needle)) score += 15;
        return {
          module: m.name,
          moduleId: m.id,
          displayName: m.shortdesc || m.name,
          state: m.state,
          reason: "manual search",
          source: "manual",
          score,
        };
      })
      .sort((a, b) => b.score - a.score || a.module.localeCompare(b.module));
  }

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== CHANNEL || data.direction !== "content-to-page") return;

    const { requestId, action, payload } = data;
    try {
      if (action === "ping") {
        reply(requestId, { ok: true, result: { active: isOdooBackend() } });
        return;
      }
      if (action === "detect") {
        const result = await resolveCandidates();
        reply(requestId, { ok: true, result });
        return;
      }
      if (action === "upgrade") {
        const result = await upgradeModule(payload?.module);
        reply(requestId, { ok: true, result });
        return;
      }
      if (action === "searchModules") {
        const result = await searchModules(payload?.query || "");
        reply(requestId, { ok: true, result });
        return;
      }
      reply(requestId, { ok: false, error: `Unknown action: ${action}` });
    } catch (err) {
      const message =
        err?.data?.message ||
        err?.message?.data?.message ||
        err?.message ||
        String(err);
      reply(requestId, { ok: false, error: message });
    }
  });

  // Announce readiness to content script
  window.postMessage(
    {
      source: CHANNEL,
      direction: "page-to-content",
      action: "ready",
      result: { active: isOdooBackend() },
    },
    "*",
  );
})();
