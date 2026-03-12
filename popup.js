'use strict';

// ── Translations ──────────────────────────────────────────────────────────────────────────────
const TRANSLATIONS = {
  en: {
    brandSubtitle:       'Remove Background Music.',
    tabDetecting:        'Detecting tab…',
    vizReady:            'Ready',
    vizOn:               'On',
    vizOff:              'Off',
    powerTurnOn:         'Turn on',
    powerTurnOff:        'Turn off',
    helperDefault:       'Works on the active browser tab.',
    helperAlmostThere:   'Almost there.',
    helperFiltering:     'Filtering is on for this tab.',
    helperSwitching:     'Switching…',
    helperExtOff:        'Extension is off.',
    helperTryAgain:      'Try again on a tab with audio.',
    helperStarting:      'Starting…',
    loadingTitle:        'Getting ready…',
    loadingSubWasm:      'Preparing audio…',
    loadingSubCompiling: 'Getting things ready…',
    loadingSubModel:     'Loading filter…',
    loadingSubDefault:   'Getting ready…',
    loadingSubInit:      'Preparing your audio.',
    errorNoAccess:       'Could not access this tab audio.',
    errorNoStream:       'Could not start filtering.',
  },
  ar: {
    brandSubtitle:       'إزالة الموسيقى الخلفية.',
    tabDetecting:        'جارٍ الكشف عن التبويب…',
    vizReady:            'جاهز',
    vizOn:               'مفعّل',
    vizOff:              'متوقف',
    powerTurnOn:         'تشغيل',
    powerTurnOff:        'إيقاف',
    helperDefault:       'يعمل على التبويب النشط.',
    helperAlmostThere:   'لحظة…',
    helperFiltering:     'التصفية نشطة على هذا التبويب.',
    helperSwitching:     'جارٍ التبديل…',
    helperExtOff:        'الإضافة معطّلة.',
    helperTryAgain:      'حاول مرةً أخرى على تبويب به صوت.',
    helperStarting:      'جارٍ البدء…',
    loadingTitle:        'جارٍ الإعداد…',
    loadingSubWasm:      'جارٍ تجهيز الصوت…',
    loadingSubCompiling: 'جارٍ التحضير…',
    loadingSubModel:     'تحميل المرشح…',
    loadingSubDefault:   'جارٍ الإعداد…',
    loadingSubInit:      'جارٍ تجهيز صوتك.',
    errorNoAccess:       'تعذّر الوصول إلى صوت هذا التبويب.',
    errorNoStream:       'تعذّر بدء التصفية.',
  }
};

// ── Language helpers ────────────────────────────────────────────────────────────────
let currentLang = localStorage.getItem('nomusic_lang') || 'en';

function t(key) {
  return (TRANSLATIONS[currentLang] || TRANSLATIONS.en)[key] || key;
}

// State keys for re-translation on language switch
let currentPowerOn     = false;
let currentVizKey      = 'vizReady';
let currentHelperKey   = 'helperDefault';
let currentLoadingStep = null;

function applyLang(lang) {
  currentLang = lang;
  localStorage.setItem('nomusic_lang', lang);
  document.documentElement.lang = lang;
  document.documentElement.dir  = lang === 'ar' ? 'rtl' : 'ltr';
  langEN.classList.toggle('active', lang === 'en');
  langAR.classList.toggle('active', lang === 'ar');
  document.querySelector('.brand-subtitle').textContent = t('brandSubtitle');
  refreshDynamicText();
}

function refreshDynamicText() {
  powerLabel.textContent = currentPowerOn ? t('powerTurnOff') : t('powerTurnOn');
  vizLabel.textContent   = t(currentVizKey);

  loadingTitle.textContent = t('loadingTitle');
  if (currentLoadingStep) {
    const sub = 'loadingSub' + currentLoadingStep.charAt(0).toUpperCase() + currentLoadingStep.slice(1);
    loadingSub.textContent = t(sub) || t('loadingSubDefault');
  } else {
    loadingSub.textContent = t('loadingSubInit');
  }

  if (!activeTabId) tabTitle.textContent = t('tabDetecting');
}

// Convenience setters
function setViz(key)    { currentVizKey    = key; vizLabel.textContent   = t(key); }
function setHelper(key) { currentHelperKey = key; }
function setPower(on) {
  currentPowerOn = on;
  powerLabel.textContent = on ? t('powerTurnOff') : t('powerTurnOn');
}
function setBadge(_state, _label) { /* badge removed — no-op */ }

// ── State & DOM refs ─────────────────────────────────────────────────────────────────
let isActive       = false;
let activeTabId    = null;
let extensionEnabled = true;
let animFrameId    = null;
let freqData       = null;

const $ = id => document.getElementById(id);
const powerBtn         = $('powerBtn');
const powerLabel       = $('powerLabel');
const tabTitle         = $('tabTitle');
const loadingOverlay   = $('loadingOverlay');
const loadingTitle     = $('loadingTitle');
const loadingSub       = $('loadingSub');
const progressBar      = $('progressBar');
const errorToast       = $('errorToast');
const errorMsg         = $('errorMsg');
const vizCanvas        = $('visualizerCanvas');
const vizLabel         = $('vizLabel');
const visualizerWrap   = $('visualizerWrap');
const tabFavicon       = $('tabFavicon');
const tabIconSvg       = $('tabIconSvg');
const langEN           = $('langEN');
const langAR           = $('langAR');
const ctx2d            = vizCanvas.getContext('2d');

// ── Lang switcher ──────────────────────────────────────────────────────────────────────────
function _initLangSwitcher() {
  langEN.addEventListener('click', () => applyLang('en'));
  langAR.addEventListener('click', () => applyLang('ar'));
}

async function startFiltering() {
  try {
    powerBtn.disabled = true;
    setHelper('helperAlmostThere');

    const streamId = await new Promise((resolve, reject) => {
      const opts = activeTabId != null ? { targetTabId: activeTabId } : {};
      chrome.tabCapture.getMediaStreamId(opts, id => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (id) resolve(id);
        else reject(new Error(t('errorNoAccess')));
      });
    });

    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'START_FILTERING',
        streamId,
        tabId: activeTabId,
        suppressionLevel: 100
      }, resp => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (resp && resp.ok) resolve();
        else reject(new Error((resp && resp.error) || t('errorNoStream')));
      });
    });
  } catch (err) {
    console.error('[NoMusic popup] startFiltering:', err);
    setHelper('helperTryAgain');
    showError(err.message);
    powerBtn.disabled = false;
  }
}

function stopFiltering() {
  powerBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'STOP_FILTERING' });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'DF_STATUS') handleStatus(msg);
  if (msg.type === 'DF_FREQ_DATA') freqData = msg.data;
});

function handleStatus(msg) {
  switch (msg.state) {
    case 'loading': {
      if (msg.step === 'capture') break;
      const pct = msg.progress != null ? msg.progress : 0;
      currentLoadingStep = msg.step || null;
      const subKey = currentLoadingStep
        ? ('loadingSub' + currentLoadingStep.charAt(0).toUpperCase() + currentLoadingStep.slice(1))
        : 'loadingSubDefault';
      setProgress(pct);
      loadingTitle.textContent = t('loadingTitle');
      loadingSub.textContent   = t(subKey) || t('loadingSubDefault');
      loadingOverlay.style.display = 'flex';
      break;
    }
    case 'active': {
      loadingOverlay.style.display = 'none';
      isActive = true;
      powerBtn.classList.add('active');
      powerBtn.disabled = false;
      setPower(true);
      setHelper('helperFiltering');
      visualizerWrap.classList.add('active');
      setViz('vizOn');
      startVisualizer();
      break;
    }
    case 'stopped': {
      loadingOverlay.style.display = 'none';
      isActive = false;
      powerBtn.classList.remove('active');
      powerBtn.disabled = false;
      visualizerWrap.classList.remove('active');
      stopVisualizer();
      freqData = null;

      if (extensionEnabled) {
        setPower(true);
        setViz('vizReady');
        setHelper('helperSwitching');
      } else {
        setPower(false);
        setViz('vizOff');
        setHelper('helperExtOff');
      }
      break;
    }
    case 'error': {
      loadingOverlay.style.display = 'none';
      isActive = false;
      powerBtn.classList.remove('active');
      powerBtn.disabled = false;
      setHelper('helperTryAgain');
      visualizerWrap.classList.remove('active');
      setViz('vizReady');
      stopVisualizer();
      showError(msg.error || 'Something went wrong.');
      setPower(extensionEnabled);
      break;
    }
  }
}

let idlePhase = 0;
function drawIdle() {
  const W = vizCanvas.width, H = vizCanvas.height;
  ctx2d.clearRect(0, 0, W, H);
  idlePhase += 0.02;
  ctx2d.beginPath();
  ctx2d.moveTo(0, H / 2);
  for (let x = 0; x <= W; x++) {
    const y = H / 2 + Math.sin(x * 0.04 + idlePhase) * 4
                    + Math.sin(x * 0.02 - idlePhase * 0.7) * 3;
    ctx2d.lineTo(x, y);
  }
  ctx2d.strokeStyle = 'rgba(17,17,17,0.14)';
  ctx2d.lineWidth = 2;
  ctx2d.stroke();
}

let smoothBars = null;
function startVisualizer() {
  const W = vizCanvas.width, H = vizCanvas.height;
  const bars = 64;

  if (!smoothBars) smoothBars = new Float32Array(bars);

  function frame() {
    animFrameId = requestAnimationFrame(frame);
    const data = freqData;
    ctx2d.clearRect(0, 0, W, H);

    if (!data) { drawIdle(); return; }

    // Build smooth points
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor(i * data.length / bars);
      const target = data[idx] / 255;
      smoothBars[i] += (target - smoothBars[i]) * 0.18;
    }

    // Draw as a filled wave
    const mid = H / 2;
    const grad = ctx2d.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, 'rgba(255,144,201,0.55)');
    grad.addColorStop(0.5, 'rgba(255,144,201,0.20)');
    grad.addColorStop(1, 'rgba(255,144,201,0.55)');

    ctx2d.fillStyle = grad;
    ctx2d.beginPath();
    ctx2d.moveTo(0, mid);

    // Top wave
    for (let i = 0; i <= bars; i++) {
      const x = (i / bars) * W;
      const v = smoothBars[Math.min(i, bars - 1)];
      const y = mid - v * mid * 0.85;
      if (i === 0) ctx2d.lineTo(x, y);
      else {
        const px = ((i - 1) / bars) * W;
        const cx = (px + x) / 2;
        ctx2d.quadraticCurveTo(px, mid - smoothBars[i - 1] * mid * 0.85, cx, (mid - smoothBars[i - 1] * mid * 0.85 + y) / 2);
        ctx2d.lineTo(x, y);
      }
    }

    ctx2d.lineTo(W, mid);

    // Bottom wave (mirror)
    for (let i = bars; i >= 0; i--) {
      const x = (i / bars) * W;
      const v = smoothBars[Math.min(i, bars - 1)];
      const y = mid + v * mid * 0.85;
      ctx2d.lineTo(x, y);
    }

    ctx2d.closePath();
    ctx2d.fill();

    // Bright center line
    ctx2d.beginPath();
    ctx2d.moveTo(0, mid);
    for (let i = 0; i <= bars; i++) {
      const x = (i / bars) * W;
      const v = smoothBars[Math.min(i, bars - 1)];
      const y = mid - v * mid * 0.7;
      ctx2d.lineTo(x, y);
    }
    ctx2d.strokeStyle = 'rgba(255,144,201,0.7)';
    ctx2d.lineWidth = 2;
    ctx2d.stroke();
  }

  frame();
}

function stopVisualizer() {
  if (animFrameId != null) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  smoothBars = null;
  drawIdle();
}

// setBadge is defined earlier as a no-op; this block intentionally removed.

function setProgress(frac) {
  progressBar.style.width = (Math.min(1, Math.max(0, frac)) * 100).toFixed(1) + '%';
}

let errorTimer = null;
function showError(msg) {
  errorMsg.textContent     = msg;
  errorToast.style.display = 'flex';
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => { errorToast.style.display = 'none'; }, 4000);
}

powerBtn.addEventListener('click', () => {
  powerBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'TOGGLE_EXTENSION' }, resp => {
    if (!resp) { powerBtn.disabled = false; return; }
    extensionEnabled = resp.enabled;

    if (extensionEnabled) {
      startFiltering();
    } else {
      isActive = false;
      powerBtn.classList.remove('active');
      powerBtn.disabled = false;
      setPower(false);
      setHelper('helperExtOff');
      visualizerWrap.classList.remove('active');
      setViz('vizOff');
      stopVisualizer();
      freqData = null;
    }
  });
});

async function boot() {
  // Apply saved language first
  _initLangSwitcher();
  applyLang(currentLang);

  // 1. Get active tab info
  const tabResp = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, r));
  if (tabResp && tabResp.tabId != null) {
    activeTabId = tabResp.tabId;
    const displayName = (tabResp.title || tabResp.url || 'Tab ' + tabResp.tabId)
      .replace(/^(https?:\/\/)?(www\.)?/, '').slice(0, 60);
    tabTitle.textContent = displayName;

    if (tabResp.favIconUrl) {
      tabFavicon.src = tabResp.favIconUrl;
      tabFavicon.style.display = '';
      tabIconSvg.style.display = 'none';
      tabFavicon.onerror = () => { tabFavicon.style.display = 'none'; tabIconSvg.style.display = ''; };
    }
  }

  // 2. Get engine state
  const stateResp = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_ENGINE_STATE' }, r));
  extensionEnabled = stateResp ? stateResp.enabled !== false : true;

  if (!extensionEnabled) {
    powerBtn.disabled = false;
    setPower(false);
    setHelper('helperExtOff');
    setViz('vizOff');
  } else if (stateResp && stateResp.activeTabId === activeTabId) {
    isActive = true;
    powerBtn.classList.add('active');
    powerBtn.disabled = false;
    setPower(true);
    setHelper('helperFiltering');
    visualizerWrap.classList.add('active');
    setViz('vizOn');
    startVisualizer();
  } else {
    powerBtn.disabled = false;
    setPower(true);
    setHelper('helperStarting');
    startFiltering();
  }

  // Idle animation loop
  function idleLoop() {
    if (!isActive) drawIdle();
    requestAnimationFrame(idleLoop);
  }
  idleLoop();
}

document.addEventListener('DOMContentLoaded', boot);
