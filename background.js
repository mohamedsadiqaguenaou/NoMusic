/**
 * background.js — NoMusic service worker
 *
 * Responsibilities:
 *  1. Orchestrate the offscreen document (create / keep alive / close)
 *  2. Auto-follow the active tab — filter whichever tab the user is looking at
 *  3. Mute tabs the user leaves so only the active tab plays
 *  4. Persist a global enabled/disabled state (defaults ON)
 *  5. Relay messages between popup ↔ offscreen
 */

'use strict';

const MODEL_URLS = {
  lite:     'assets/fastenhancer_t.onnx',
  standard: 'assets/fastenhancer_s.onnx'
};

function getModelUrl() {
  return new Promise(resolve => {
    chrome.storage.local.get(['nomusic_model'], r => {
      const tier = r.nomusic_model === 'lite' ? 'lite' : 'standard';
      resolve(chrome.runtime.getURL(MODEL_URLS[tier]));
    });
  });
}

let offscreenCreating = false;
let extensionEnabled  = true;   // defaults ON — loaded from storage below
let activeTabId       = null;
let mutedTabs         = new Set();
let engineWarmed      = false;  // true once offscreen engine is ready to process audio

// ── Restore persisted state ──────────────────────────────────────────────────
chrome.storage.local.get(['extensionEnabled'], r => {
  if (r.extensionEnabled !== undefined) extensionEnabled = r.extensionEnabled;
});

// Try to capture whichever tab the user is currently looking at.
async function captureCurrentTab() {
  await refreshEnabled();
  if (!extensionEnabled) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id) {
      // Force-allow even if activeTabId matches (first capture after restart)
      if (tab.id === activeTabId) activeTabId = null;
      await autoCapture(tab.id);
    }
  } catch (_) {}
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['extensionEnabled'], r => {
    if (r.extensionEnabled === undefined) {
      chrome.storage.local.set({ extensionEnabled: true });
    }
  });
  // Just create the offscreen doc — captureCurrentTab will be triggered
  // by ENGINE_READY once the engine finishes pre-warming.
  ensureOffscreen().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen().catch(() => {});
});

// ── Offscreen document helpers ───────────────────────────────────────────────

async function ensureOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (existing) return;
  } catch (_) {
    return; // API not available yet
  }

  if (offscreenCreating) {
    await new Promise(resolve => {
      const iv = setInterval(async () => {
        try {
          if (await chrome.offscreen.hasDocument()) { clearInterval(iv); resolve(); }
        } catch (_) { clearInterval(iv); resolve(); }
      }, 100);
    });
    return;
  }

  offscreenCreating = true;
  try {
    await chrome.offscreen.createDocument({
      url:           'offscreen.html',
      reasons:       ['USER_MEDIA', 'AUDIO_PLAYBACK'],
      justification: 'Capture tab audio and run FastEnhancer plus RNNoise speech enhancement.'
    });
  } catch (err) {
    // "Invalid state" or "Only a single offscreen..." — doc already exists
    console.warn('[NoMusic] ensureOffscreen:', err.message);
  } finally {
    offscreenCreating = false;
  }
}

// ── Auto-follow active tab ──────────────────────────────────────────────────

async function refreshEnabled() {
  const { extensionEnabled: e = true } = await chrome.storage.local.get('extensionEnabled');
  extensionEnabled = e;
  return e;
}

function isCapturable(url) {
  return url && (url.startsWith('http://') || url.startsWith('https://'));
}

// ── Capture serialization ───────────────────────────────────────────────────
// Only one _doCapture runs at a time.  When a new tab-switch arrives while one
// is in flight we record the latest requested tabId and process it once the
// current one finishes — stale intermediate tabs are skipped entirely.
let _captureRunning = false;
let _nextTabId      = undefined; // undefined = nothing queued

async function autoCapture(newTabId) {
  if (newTabId != null && newTabId === activeTabId) return;

  if (_captureRunning) {
    _nextTabId = newTabId; // latest wins — supersedes any earlier pending tab
    return;
  }

  _captureRunning = true;
  let tabId = newTabId;
  try {
    while (tabId !== undefined) {
      _nextTabId = undefined;
      if (tabId == null || tabId !== activeTabId) await _doCapture(tabId);
      tabId = _nextTabId; // pick up anything queued while we were working
    }
  } finally {
    _captureRunning = false;
    _nextTabId      = undefined;
  }
}

async function _doCapture(newTabId) {
  if (newTabId == null || newTabId === activeTabId) return;

  // If we don't know the engine state yet, ask the offscreen doc
  if (!engineWarmed) {
    try {
      await ensureOffscreen();
      const resp = await chrome.runtime.sendMessage({ type: 'DF_GET_STATUS' });
      if (resp && resp.engineReady) engineWarmed = true;
    } catch (_) {}
    if (!engineWarmed) return; // still not ready
  }

  // Stop old capture and mute the old tab
  if (activeTabId != null) {
    const oldId = activeTabId;
    activeTabId = null;
    await ensureOffscreen();
    try { await chrome.runtime.sendMessage({ type: 'DF_STOP' }); } catch (_) {}
    chrome.tabs.update(oldId, { muted: true }).catch(() => {});
    mutedTabs.add(oldId);
  }

  // Bail out if a newer tab-switch arrived while we were stopping.
  if (_nextTabId !== undefined) return;

  // Verify the new tab is capturable
  let tab;
  try { tab = await chrome.tabs.get(newTabId); } catch (_) { return; }
  if (!isCapturable(tab.url)) return;

  // Bail out if superseded while checking the new tab state.
  if (_nextTabId !== undefined) return;

  // Try to obtain a capture token from the service worker.
  // This works in Chrome 116+ from tabs.onActivated / windows.onFocusChanged.
  // If it fails the popup will handle capture on open.
  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: newTabId }, id => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (id) resolve(id); else reject(new Error('empty'));
      });
    });

    // Bail out if a newer switch arrived while we waited for the stream ID.
    if (_nextTabId !== undefined) return;

    // Unmute new tab (it may have been muted from a previous cycle)
    mutedTabs.delete(newTabId);
    chrome.tabs.update(newTabId, { muted: false }).catch(() => {});

    activeTabId = newTabId;
    await ensureOffscreen();
    const modelUrl = await getModelUrl();
    chrome.runtime.sendMessage({
      type:             'DF_START',
      streamId,
      tabId:            newTabId,
      suppressionLevel: 100,
      modelUrl
    }).catch(() => {});
  } catch (err) {
    console.warn('[NoMusic] autoCapture failed for tab', newTabId, ':', err.message);
    // Will retry on next ENGINE_READY, tab switch, or page load
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!(await refreshEnabled())) return;
  await autoCapture(activeInfo.tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (!(await refreshEnabled())) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) await autoCapture(tab.id);
  } catch (_) {}
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function unmuteAll() {
  for (const tabId of mutedTabs) {
    chrome.tabs.update(tabId, { muted: false }).catch(() => {});
  }
  mutedTabs.clear();
}

function relayToPopups(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {}); // popup may be closed — ignore
}

// ── Message routing ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── Popup → Background ────────────────────────────────────────────────
  if (msg.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      sendResponse(tabs && tabs[0]
        ? { tabId: tabs[0].id, title: tabs[0].title, url: tabs[0].url, favIconUrl: tabs[0].favIconUrl }
        : { error: 'No active tab' });
    });
    ensureOffscreen().catch(() => {});
    return true;
  }

  if (msg.type === 'GET_ENGINE_STATE') {
    sendResponse({ activeTabId, enabled: extensionEnabled });
    return false;
  }

  if (msg.type === 'TOGGLE_EXTENSION') {
    extensionEnabled = !extensionEnabled;
    chrome.storage.local.set({ extensionEnabled });

    if (!extensionEnabled) {
      // Disable: stop capture and unmute every tab
      const wasActive = activeTabId;
      activeTabId = null;
      if (wasActive != null) {
        chrome.tabs.update(wasActive, { muted: false }).catch(() => {});
        chrome.runtime.sendMessage({ type: 'DF_STOP' }).catch(() => {});
      }
      unmuteAll();
    }

    sendResponse({ ok: true, enabled: extensionEnabled });
    return false;
  }

  if (msg.type === 'START_FILTERING') {
    (async () => {
      // Mute old tab if switching
      if (activeTabId != null && activeTabId !== msg.tabId) {
        chrome.tabs.update(activeTabId, { muted: true }).catch(() => {});
        mutedTabs.add(activeTabId);
      }
      // Unmute new tab
      if (msg.tabId != null) {
        mutedTabs.delete(msg.tabId);
        chrome.tabs.update(msg.tabId, { muted: false }).catch(() => {});
      }

      activeTabId = msg.tabId;
      await ensureOffscreen();
      chrome.runtime.sendMessage({
        type:             'DF_START',
        streamId:         msg.streamId,
        tabId:            msg.tabId,
        suppressionLevel: msg.suppressionLevel,
        modelUrl:         msg.modelUrl
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'STOP_FILTERING') {
    (async () => {
      if (activeTabId != null) {
        chrome.tabs.update(activeTabId, { muted: false }).catch(() => {});
        mutedTabs.delete(activeTabId);
        activeTabId = null;
      }
      chrome.runtime.sendMessage({ type: 'DF_STOP' }).catch(() => {});
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'SET_LEVEL') {
    chrome.runtime.sendMessage({ type: 'DF_SET_LEVEL', value: msg.value }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  // ── Offscreen → Background (relay status to popup) ────────────────────
  if (msg.type === 'DF_STATUS') {
    if (msg.state === 'active' && activeTabId != null) {
      chrome.tabs.update(activeTabId, { muted: true }).catch(() => {});
    }
    if (msg.state === 'error' || msg.state === 'stopped') {
      // Reset activeTabId so ENGINE_READY or next tab-switch can retry
      if (activeTabId != null) {
        chrome.tabs.update(activeTabId, { muted: false }).catch(() => {});
        mutedTabs.delete(activeTabId);
        activeTabId = null;
      }
    }
    relayToPopups(msg);
    return false;
  }

  if (msg.type === 'DF_FREQ_DATA') {
    relayToPopups(msg);
    return false;
  }

  // Offscreen engine finished pre-warming → try auto-capture if idle
  if (msg.type === 'ENGINE_READY') {
    engineWarmed = true;
    if (extensionEnabled && activeTabId == null) {
      captureCurrentTab();
    }
    return false;
  }
});

// ── Tab lifecycle ────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(tabId => {
  mutedTabs.delete(tabId);
  if (tabId === activeTabId) {
    activeTabId = null;
    chrome.runtime.sendMessage({ type: 'DF_STOP' }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!extensionEnabled) return;

  // Case 1: Active-filtered tab navigated to a new URL — stop, then re-capture
  if (tabId === activeTabId && changeInfo.url) {
    chrome.runtime.sendMessage({ type: 'DF_STOP' }).catch(() => {});
    chrome.tabs.update(tabId, { muted: false }).catch(() => {});
    mutedTabs.delete(tabId);
    activeTabId = null;
    // Re-capture once the new page settles
    setTimeout(() => autoCapture(tabId).catch(() => {}), 1500);
    return;
  }

  // Case 2: Any tab finishes loading — if it's the active tab in the focused
  // window and we're not already filtering it, auto-capture it.
  // This handles: page refresh (F5), new tab navigated to a site, etc.
  if (changeInfo.status === 'complete' && tab && isCapturable(tab.url)) {
    if (tabId === activeTabId) return; // already filtering
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      if (tabs && tabs[0] && tabs[0].id === tabId) {
        autoCapture(tabId).catch(() => {});
      }
    });
  }
});
