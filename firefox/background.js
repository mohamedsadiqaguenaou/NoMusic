/**
 * background.js — NoMusic background script (Firefox build)
 *
 * Firefox has neither chrome.tabCapture nor offscreen documents. The audio engine runs inside the page
 * (see media-hook.js); this script only decides which tab is filtered:
 *  1. Auto-follow the active tab (when "Turn on automatically" is on) and tell content scripts to filter
 *     or bypass
 *  2. Mute tabs the user leaves so only the active tab plays
 *  3. Answer the same popup messages as the Chrome service worker, so popup.js is shared
 *
 * It holds no audio state, so it is fine for Firefox to unload this event page when idle.
 */

'use strict';

const MODEL_URLS = {
  lite:     browser.runtime.getURL('assets/fastenhancer_t.wasm'),
  standard: browser.runtime.getURL('assets/fastenhancer_s.wasm')
};
const VIZ_WANTED_TTL_MS = 2500;

let extensionEnabled = true;
let continueAudioOnTabSwitch = false;
let activeTabId = null;
let modelUrl = MODEL_URLS.standard;
let wet = 1;
let vizWantedUntil = 0;
const mutedTabs = new Set();

async function autoOnAllowed() {
  const { extensionEnabled: e = true, nomusic_autoOn: autoOn = true } =
    await browser.storage.local.get(['extensionEnabled', 'nomusic_autoOn']);
  extensionEnabled = e;
  return e && autoOn;
}

function isFilterable(url) {
  return url && (url.startsWith('http://') || url.startsWith('https://'));
}

// Only message the popup while it is open (it pings VIZ_WANTED from the moment it loads): Firefox reports
// a sendMessage with no receiver as an uncaught error even when the rejection is handled.
function sendStatus(state, extra) {
  if (Date.now() > vizWantedUntil) return;
  browser.runtime.sendMessage({ type: 'DF_STATUS', state, ...(extra || {}) }).catch(() => {});
}

function tellTab(tabId, msg) {
  browser.tabs.sendMessage(tabId, msg).catch(() => {}); // no content script (e.g. about: pages)
}

function modeFor(tabId) {
  return { type: 'NM_MODE', mode: tabId === activeTabId ? 'filter' : 'bypass', modelUrl, wet };
}

function setMuted(tabId, muted) {
  if (muted) mutedTabs.add(tabId); else mutedTabs.delete(tabId);
  browser.tabs.update(tabId, { muted }).catch(() => {});
}

function unmuteAll() {
  for (const tabId of mutedTabs) browser.tabs.update(tabId, { muted: false }).catch(() => {});
  mutedTabs.clear();
}

function setActiveTab(tabId) {
  activeTabId = tabId;
  browser.storage.session.set({ nomusic_activeTabId: tabId }).catch(() => {});
}

async function activateTab(tabId, { force = false, model } = {}) {
  if (tabId == null || (tabId === activeTabId && !force && !model)) return;
  let tab;
  try { tab = await browser.tabs.get(tabId); } catch (_) { return; }
  if (!isFilterable(tab.url)) return;

  if (model) modelUrl = model;
  const oldId = activeTabId;
  if (oldId != null && oldId !== tabId) {
    tellTab(oldId, { type: 'NM_MODE', mode: 'bypass' });
    setMuted(oldId, !continueAudioOnTabSwitch);
  }
  setActiveTab(tabId);
  setMuted(tabId, false);
  tellTab(tabId, modeFor(tabId));
  sendStatus('active', { latency: 11, engine: modelUrl.split('/').pop() });
}

function deactivate() {
  if (activeTabId != null) {
    tellTab(activeTabId, { type: 'NM_MODE', mode: 'bypass' });
    setMuted(activeTabId, false);
    setActiveTab(null);
  }
  sendStatus('stopped');
}

async function focusedTabId() {
  const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ? tab.id : null;
}

// ── Tab events ───────────────────────────────────────────────────────────────

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  await ready;
  if (continueAudioOnTabSwitch && activeTabId != null) return;
  if (!(await autoOnAllowed())) return;
  await activateTab(tabId);
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === browser.windows.WINDOW_ID_NONE) return;
  await ready;
  if (continueAudioOnTabSwitch && activeTabId != null) return;
  if (!(await autoOnAllowed())) return;
  const [tab] = await browser.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) await activateTab(tab.id);
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  mutedTabs.delete(tabId);
  if (tabId === activeTabId) setActiveTab(null);
});

// A reload or navigation of the filtered tab ends filtering when auto-on is off (as in the Chrome build).
// With auto-on, the new page asks again (NM_HELLO) and keeps being filtered.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  await ready;
  if (tabId === activeTabId && !(await autoOnAllowed()) && tabId === activeTabId) deactivate();
}, { properties: ['status'] });

// ── Messages ─────────────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    // ── Content script ──
    case 'NM_HELLO': {
      const tab = sender.tab;
      if (!tab) return false;
      (async () => {
        await ready;
        if (activeTabId == null && tab.active && (await autoOnAllowed()) && tab.id === (await focusedTabId())) {
          await activateTab(tab.id);
        }
        sendResponse(modeFor(tab.id));
      })();
      return true;
    }

    case 'NM_ERROR':
      if (sender.tab && sender.tab.id === activeTabId) sendStatus('error', { error: msg.error });
      return false;

    // ── Popup ──
    case 'VIZ_WANTED':
      vizWantedUntil = Date.now() + VIZ_WANTED_TTL_MS;
      if (activeTabId != null) tellTab(activeTabId, { type: 'NM_VIZ' });
      return false;

    case 'GET_ACTIVE_TAB':
      browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
        sendResponse(tabs && tabs[0]
          ? { tabId: tabs[0].id, title: tabs[0].title, url: tabs[0].url, favIconUrl: tabs[0].favIconUrl }
          : { error: 'No active tab' });
      });
      return true;

    case 'GET_ENGINE_STATE':
      ready.then(() => sendResponse({ activeTabId, enabled: extensionEnabled }));
      return true;

    case 'TOGGLE_EXTENSION':
      extensionEnabled = typeof msg.enabled === 'boolean' ? msg.enabled : !extensionEnabled;
      browser.storage.local.set({ extensionEnabled });
      if (!extensionEnabled) {
        ready.then(() => { deactivate(); unmuteAll(); });
      }
      sendResponse({ ok: true, enabled: extensionEnabled });
      return false;

    case 'START_FILTERING':
      // No stream id on Firefox: the content script in that tab filters its own media.
      vizWantedUntil = Date.now() + VIZ_WANTED_TTL_MS;
      ready.then(() => activateTab(msg.tabId, { force: true, model: msg.modelUrl }))
        .then(() => sendResponse({ ok: true }));
      return true;

    case 'STOP_FILTERING':
      ready.then(deactivate).then(() => sendResponse({ ok: true }));
      return true;

    case 'SET_LEVEL':
      wet = Math.max(0, Math.min(100, msg.value | 0)) / 100;
      if (activeTabId != null) tellTab(activeTabId, { type: 'NM_SET_WET', wet });
      sendResponse({ ok: true });
      return false;

    case 'SET_CONTINUE_AUDIO':
      continueAudioOnTabSwitch = !!msg.value;
      if (continueAudioOnTabSwitch) {
        unmuteAll();
      } else {
        for (const tabId of mutedTabs) browser.tabs.update(tabId, { muted: true }).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

// ── Startup ──────────────────────────────────────────────────────────────────

browser.runtime.onInstalled.addListener(() => {
  browser.storage.local.get(['extensionEnabled']).then((r) => {
    if (r.extensionEnabled === undefined) browser.storage.local.set({ extensionEnabled: true });
  });
});

// The event page can be unloaded when idle; restore its state when it starts again.
const ready = (async () => {
  const r = await browser.storage.local.get(['extensionEnabled', 'nomusic_continueAudio', 'nomusic_model']);
  if (r.extensionEnabled !== undefined) extensionEnabled = r.extensionEnabled;
  if (r.nomusic_continueAudio !== undefined) continueAudioOnTabSwitch = r.nomusic_continueAudio;
  modelUrl = MODEL_URLS[r.nomusic_model === 'lite' ? 'lite' : 'standard'];
  const s = await browser.storage.session.get(['nomusic_activeTabId']).catch(() => ({}));
  if (extensionEnabled && s.nomusic_activeTabId != null) {
    activeTabId = s.nomusic_activeTabId;
  } else if (await autoOnAllowed()) {
    const tabId = await focusedTabId().catch(() => null);
    if (tabId != null) {
      activeTabId = null;
      await activateTab(tabId);
    }
  }
})().catch(() => {});
