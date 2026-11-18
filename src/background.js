const ENABLED_KEY = "odooUpgradeEnabled";

const BADGE = {
  on: {
    text: "ON",
    color: "#2e7d32",
    title: "Odoo One-Click Upgrade — ON (click to disable)",
  },
  off: {
    text: "OFF",
    color: "#757575",
    title: "Odoo One-Click Upgrade — OFF (click to enable)",
  },
  idle: {
    text: "",
    color: "#9e9e9e",
    title: "Odoo One-Click Upgrade — ON (click to disable)",
  },
};

async function getEnabled() {
  const data = await chrome.storage.local.get(ENABLED_KEY);
  return data[ENABLED_KEY] !== false;
}

async function setEnabled(enabled) {
  await chrome.storage.local.set({ [ENABLED_KEY]: Boolean(enabled) });
}

async function applyBadge(tabId, state) {
  const badge = BADGE[state] || BADGE.idle;
  const target = typeof tabId === "number" ? { tabId } : {};
  await chrome.action.setBadgeText({ ...target, text: badge.text });
  await chrome.action.setBadgeBackgroundColor({ ...target, color: badge.color });
  await chrome.action.setTitle({ ...target, title: badge.title });
}

async function syncAllTabs(enabled) {
  await applyBadge(undefined, enabled ? "idle" : "off");

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (_err) {
    tabs = [];
  }

  for (const tab of tabs) {
    if (typeof tab.id !== "number") continue;
    await applyBadge(tab.id, enabled ? "idle" : "off");
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "odoo_upgrade_set_enabled",
        enabled,
      });
    } catch (_err) {
      // Tab may not have the content script
    }
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(ENABLED_KEY);
  if (typeof data[ENABLED_KEY] !== "boolean") {
    await setEnabled(true);
  }
  const enabled = await getEnabled();
  await applyBadge(undefined, enabled ? "idle" : "off");
});

chrome.runtime.onStartup.addListener(async () => {
  const enabled = await getEnabled();
  await applyBadge(undefined, enabled ? "idle" : "off");
});

chrome.action.onClicked.addListener(async () => {
  const enabled = !(await getEnabled());
  await setEnabled(enabled);
  await syncAllTabs(enabled);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "odoo_upgrade_get_enabled") {
    getEnabled()
      .then((enabled) => sendResponse({ ok: true, enabled }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "odoo_upgrade_status") {
    const tabId = sender.tab?.id;
    (async () => {
      const enabled = await getEnabled();
      if (!enabled) {
        if (typeof tabId === "number") await applyBadge(tabId, "off");
        sendResponse({ ok: true, enabled: false });
        return;
      }
      if (typeof tabId === "number") {
        await applyBadge(tabId, message.active ? "on" : "idle");
      }
      sendResponse({ ok: true, enabled: true });
    })().catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
