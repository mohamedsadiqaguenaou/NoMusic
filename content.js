/**
 * content.js
 * Works around the Chrome tabCapture fullscreen bug.
 * When a tab is being captured and an element requests fullscreen,
 * Chrome restricts it to windowed fullscreen instead of true OS fullscreen.
 * We detect the document's fullscreen state and ask the background script
 * to toggle the OS-level browser window fullscreen instead.
 */

function handleFullscreenChange() {
  // Guard against invalidated extension context (e.g. after extension reload)
  if (!chrome.runtime?.id) return;
  try {
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    chrome.runtime.sendMessage({ type: isFullscreen ? 'ENTER_FULLSCREEN' : 'EXIT_FULLSCREEN' }).catch(() => {});
  } catch (_) {}
}

document.addEventListener('fullscreenchange', handleFullscreenChange);
document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
