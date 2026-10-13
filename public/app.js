const tr = (...args) => window.MediaTrackerI18n
  ? window.MediaTrackerI18n.tr(...args)
  : typeof args[0] === "string" ? args[0]
    : args[0].reduce((text, part, index) => text + part + (index < args.length - 1 ? String(args[index + 1]) : ""), "");
const tm = (message, context) => window.MediaTrackerI18n?.translateMessage(message, context) ?? String(message ?? "");
const uiLocale = () => window.MediaTrackerI18n?.locale || "zh-CN";
let languageRefreshing = false;
let pendingLanguagePreference = null;
let savedLanguagePreference = "system";
let languageSaveSequence = 0;
let languageSaveQueue = Promise.resolve();
let systemLanguageTimer;
let pendingThemePreference = null;
let savedThemePreference = "system";
let themeSaveSequence = 0;
let themeSaveQueue = Promise.resolve();

window.MediaTrackerI18n?.register({
  "界面语言已切换。": "Display language changed.",
  "无法保存界面语言，已恢复上次设置。": "Could not save the display language. The last saved setting has been restored.",
  "无法保存界面主题，已恢复上次设置。": "Could not save the theme. The last saved setting has been restored.",
  "删除所选历史资料夹（": "Delete selected historical profiles (",
  "Media Tracker · 公开最小版": "Media Tracker · Public Minimal Edition",
  "公开最小版 · 独立数据": "Public minimal · Separate data",
  "登录资料含敏感信息": "Login profiles contain sensitive data",
  "gallery-dl（发行版未集成，请改选）": "gallery-dl (not included; choose another engine)",
  "确认后从 Gyan 下载固定版本 FFmpeg 与 ffprobe（GPL-3.0-or-later），核对 SHA-256 后保存在本工具的 tools 中，并保留提供者的许可及来源说明。不是 MIT 组件；如再分发，需自行满足其 GPL 及对应源码义务。也可以取消后指定已有工具。不改系统设置、不上传媒体或登录信息，完成后不自动开始去重；精确去重不受影响。": "After confirmation, download the pinned FFmpeg and ffprobe build from Gyan (GPL-3.0-or-later), verify SHA-256 and keep it under this tool's tools directory with the provider's license and source information. This is not an MIT component. Redistribution requires compliance with its GPL and corresponding-source obligations. You can cancel and select existing tools instead. No system settings are changed, no media or login data is uploaded, and deduplication does not start automatically. Exact deduplication is unaffected.",
  "确认后从 Gyan 下载固定版本 FFmpeg 与 ffprobe（GPL-3.0-or-later），核对 SHA-256 后保存在所选位置，并保留提供者的许可及来源说明。不是 MIT 组件；如再分发，需自行满足其 GPL 及对应源码义务。也可取消并指定已有工具。不改系统设置，不上传媒体或登录信息，下载完成前不开始去重。": "After confirmation, download the pinned FFmpeg and ffprobe build from Gyan (GPL-3.0-or-later), verify SHA-256 and retain it at your chosen location with the provider's license and source information. This is not an MIT component. Redistribution requires compliance with its GPL and corresponding-source obligations. You can cancel and select existing tools instead. System settings are unchanged, media and login data are not uploaded, and deduplication does not start before preparation completes.",
  "公开版使用须知": "Public edition usage notice",
  "已阅读，继续操作": "Read and continue",
  "尚未确认使用须知，未执行联网操作。": "The usage notice was not acknowledged. No online action was performed.",
  "本版采用网页采集，尚未取得平台自动采集许可。请仅采集平台规则和作品权利许可允许的内容；能登录、能查看或能手动保存不代表获准自动采集。不得绕过验证码、DRM、付费或访问限制。平台仍可能限流或封号；若与自用版共享账号或 IP，两版可能同时受影响。确认仅表示已阅读风险，不授予许可或免除责任。": "This edition collects website content and has not obtained platform permission for automation. Only collect content allowed by the platform rules and the rights holder. Login, visibility or manual saving does not authorize automated collection. Do not bypass CAPTCHA, DRM, paywalls or access controls. Platforms may rate-limit or ban accounts; sharing an account or IP with another edition can affect both. Acknowledgement means you have read the risks, not that permission has been granted or liability waived.",
});

const state = {
  linkedAccounts: [],
  persons: [],
  platforms: {},
  settings: { theme: "system", language: "system" },
  features: { dedup: null },
  runtime: { label: tr("工具内置 Chromium") },
  recentPaths: [],
  editingPersonId: null,
  draftPlatforms: [],
  homepageCandidates: [],
  homepageAnalysis: null,
  followingImport: null,
  followingSupportedPlatformIds: ["x", "instagram", "facebook", "threads", "tiktok"],
  syncSummaries: {},
  syncAllLaunching: false,
  deduplication: { job: null, launching: false, launchingPersonId: null, cancelling: false, closing: false, error: "" },
  expandedNewFilePersonIds: new Set(),
  newFilesByPerson: new Map(),
  contextFile: null,
  deletingPersonIds: new Set(),
  customPlatformSource: null,
  editingPlatformId: null,
  customPlatformTrigger: null,
  creatingPlatform: false,
  accountProbes: new Map(),
  mediaBrowser: null,
  sourceBrowser: null,
  cacheMaintenance: { report: null, phase: "preview", loading: false, cleaning: false,
    removing: false, selectedProfiles: new Set() },
};

const syncPollTimers = new Map();
const syncSummaryVersions = new Map();
let stateRefreshSequence = 0;
let dedupStatusVersion = 0;
let dedupPollTimer;
let dedupPollInFlight = false;
const dismissedDedupIds = new Set();
const closeAfterStoppingDedupIds = new Set();
let appPageClosed = false;
let pressedPersonId = null;
const deferredPersonUpdates = new Set();

// The installed/private app host injects a narrowly scoped window bridge. A
// regular browser visiting localhost must never display controls that pretend
// to minimize or close that browser.
const windowChrome = document.querySelector("#window-chrome");
const windowMaximizeButton = document.querySelector("#window-maximize");
const appearanceToolbar = document.querySelector("#appearance-toolbar");
const appearancePickers = [...appearanceToolbar.querySelectorAll(".appearance-picker")].map((picker) => ({
  trigger: picker.querySelector(".appearance-trigger"),
  menu: picker.querySelector(".appearance-menu"),
}));
let openAppearancePicker = null;
let appearancePointerPressed = false;
let nativeWindowState = null;
let nativeWindowPollTimer;
let nativeWindowQueryPending = false;
const modalWindowStack = [];

function renderNativeWindowState(value) {
  if (!value || value.frameless !== true || typeof value.maximized !== "boolean"
    || typeof window.__mediaTrackerWindow !== "function") return false;
  nativeWindowState = { maximized: value.maximized };
  document.documentElement.dataset.windowHost = "frameless";
  windowChrome.hidden = false;
  windowMaximizeButton.dataset.maximized = String(value.maximized);
  windowMaximizeButton.setAttribute("aria-pressed", String(value.maximized));
  const label = tr(value.maximized ? "还原窗口" : "最大化窗口");
  windowMaximizeButton.setAttribute("aria-label", label);
  windowMaximizeButton.title = label;
  return true;
}

function placeNativeWindowChrome() {
  // Modal dialogs make their siblings inert. Move the *same* controls into the
  // topmost modal so they remain reachable even while a confirmation is open.
  const target = [...modalWindowStack].reverse().find((dialog) => dialog.open)
    || document.body;
  // Appearance remains reachable in a normal browser too. Reparent, never
  // rebuild: a sync poll or nested modal must not replace focused settings.
  if (appearanceToolbar.parentElement !== target) {
    closeAppearanceMenu(false);
    target.append(appearanceToolbar);
  }
  if (windowChrome.parentElement !== target) target.append(windowChrome);
}

function closeAppearanceMenu(returnFocus = true) {
  if (!openAppearancePicker) return;
  const { trigger, menu } = openAppearancePicker;
  openAppearancePicker = null;
  appearancePointerPressed = false;
  menu.hidden = true;
  trigger.setAttribute("aria-expanded", "false");
  if (returnFocus) trigger.focus({ preventScroll: true });
}

function showAppearanceMenu(picker, focusChoice = true) {
  closeAppearanceMenu(false);
  openAppearancePicker = picker;
  picker.menu.hidden = false;
  picker.trigger.setAttribute("aria-expanded", "true");
  if (focusChoice) (picker.menu.querySelector("input:checked") || picker.menu.querySelector("input"))?.focus({ preventScroll: true });
}

for (const picker of appearancePickers) {
  picker.trigger.addEventListener("click", () => {
    if (openAppearancePicker === picker) closeAppearanceMenu();
    else showAppearanceMenu(picker);
  });
  picker.trigger.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    event.preventDefault();
    showAppearanceMenu(picker);
  });
  picker.menu.addEventListener("click", (event) => {
    // Label activation dispatches the real input click. Default activation and
    // its change event must finish before hiding/focusing away from the radio;
    // even a microtask runs too early in Chromium's label activation sequence.
    // This fallback also closes a click on the already selected radio.
    if (event.target.matches('input[type="radio"]')) window.setTimeout(() => {
      if (openAppearancePicker === picker) closeAppearanceMenu();
    }, 0);
  });
  picker.menu.addEventListener("change", (event) => {
    if (event.target.matches('input[type="radio"]')) closeAppearanceMenu();
  });
  picker.menu.addEventListener("keydown", (event) => {
    if (!["Home", "End"].includes(event.key) || !event.target.matches('input[type="radio"]')) return;
    event.preventDefault();
    const choices = [...picker.menu.querySelectorAll('input[type="radio"]')];
    (event.key === "Home" ? choices[0] : choices.at(-1))?.click();
  });
}
document.addEventListener("pointerdown", (event) => {
  appearancePointerPressed = appearanceToolbar.contains(event.target);
  if (openAppearancePicker && !appearanceToolbar.contains(event.target)) closeAppearanceMenu(false);
}, true);
for (const type of ["pointerup", "pointercancel"]) {
  document.addEventListener(type, () => { appearancePointerPressed = false; }, true);
}
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !openAppearancePicker) return;
  event.preventDefault();
  event.stopPropagation();
  closeAppearanceMenu();
}, true);
appearanceToolbar.addEventListener("focusout", (event) => {
  // A press on a label temporarily focuses BODY or its containing modal before
  // activating the radio. Never hide that hit target during the press. Outside
  // presses are handled above; keyboard focus leaving the toolbar still closes.
  if (openAppearancePicker && !appearancePointerPressed && event.relatedTarget
    && !appearanceToolbar.contains(event.relatedTarget)) closeAppearanceMenu(false);
});
window.addEventListener("blur", () => closeAppearanceMenu(false));

async function queryNativeWindowState() {
  if (appPageClosed || nativeWindowQueryPending || typeof window.__mediaTrackerWindow !== "function") return;
  nativeWindowQueryPending = true;
  try { renderNativeWindowState(await window.__mediaTrackerWindow("get-state")); }
  catch { /* A temporary native-query failure never invents a maximize state. */ }
  finally { nativeWindowQueryPending = false; }
}

function scheduleNativeWindowState() {
  window.clearTimeout(nativeWindowPollTimer);
  if (appPageClosed || typeof window.__mediaTrackerWindow !== "function") return;
  nativeWindowPollTimer = window.setTimeout(async () => {
    await queryNativeWindowState();
    scheduleNativeWindowState();
  }, 1500);
}

async function performNativeWindowAction(action, button) {
  if (appPageClosed || !nativeWindowState || typeof window.__mediaTrackerWindow !== "function"
    || button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const result = await window.__mediaTrackerWindow(action);
    renderNativeWindowState(result);
    if (action !== "close") await queryNativeWindowState();
  } catch { if (!appPageClosed) showToast(tr("窗口操作失败，请重试。"), true); }
  finally { if (button && !appPageClosed) button.disabled = false; }
}

windowChrome.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-window-action]");
  if (button && windowChrome.contains(button)) void performNativeWindowAction(button.dataset.windowAction, button);
});
let nativeWindowDrag = null;
const nativeWindowInteractiveSelector = [
  "button", "a", "input", "textarea", "select", "option", "label", "summary",
  "iframe", "video", "audio", "canvas", '[draggable="true"]', '[data-window-no-drag]',
  // Diagnostic text is a selection/copy surface, not a window drag surface.
  ".sync-errors",
  '[contenteditable]:not([contenteditable="false"])', '[role="button"]', '[role="link"]',
  '[role="menu"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[role="textbox"]', '[role="slider"]', '[role="tab"]', '[role="radio"]',
  '[role="checkbox"]', '[role="combobox"]', '[role="spinbutton"]',
].join(",");

function pointerOverScrollbar(event, target) {
  // Native/overlay scrollbar rails belong to scrolling, not window movement.
  // Walk ancestors because scrollbar events can target an inner content node.
  for (let node = target; node instanceof Element; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight && node.scrollWidth <= node.clientWidth) continue;
    const style = getComputedStyle(node);
    const vertical = node.scrollHeight > node.clientHeight && /auto|scroll/.test(style.overflowY);
    const horizontal = node.scrollWidth > node.clientWidth && /auto|scroll/.test(style.overflowX);
    if (!vertical && !horizontal) continue;
    const box = node.getBoundingClientRect();
    const scaleX = node.offsetWidth ? box.width / node.offsetWidth : 1;
    const scaleY = node.offsetHeight ? box.height / node.offsetHeight : 1;
    const railX = Math.max(12, node.offsetWidth - node.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth)) * scaleX;
    const railY = Math.max(12, node.offsetHeight - node.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth)) * scaleY;
    if (vertical && event.clientX >= box.right - railX && event.clientX <= box.right
      && event.clientY >= box.top && event.clientY <= box.bottom) return true;
    if (horizontal && event.clientY >= box.bottom - railY && event.clientY <= box.bottom
      && event.clientX >= box.left && event.clientX <= box.right) return true;
  }
  return false;
}

function canStartNativeWindowDrag(event) {
  const target = event.target instanceof Element ? event.target : event.target?.parentElement;
  return Boolean(nativeWindowState && target && event.button === 0
    && (!event.pointerType || event.pointerType === "mouse") && event.detail <= 1
    && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && !target.closest(nativeWindowInteractiveSelector) && !pointerOverScrollbar(event, target));
}

// Every noninteractive surface is a drag area, including headings, card text,
// paths and sidebar blanks. Diagnostic details always allow ordinary text
// selection; holding Ctrl/Shift/Alt also preserves selection on other surfaces.
// Capture on the pressed node preserves movement across gaps without replacing
// it during a sync poll; all actual controls retain their existing click behavior.
document.addEventListener("pointerdown", (event) => {
  if (!canStartNativeWindowDrag(event)) return;
  event.preventDefault();
  nativeWindowDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, target: event.target };
  try { event.target.setPointerCapture(event.pointerId); } catch { /* The pointer may already be released. */ }
}, true);
document.addEventListener("pointermove", (event) => {
  const drag = nativeWindowDrag;
  if (!drag || drag.pointerId !== event.pointerId || !(event.buttons & 1)
    || Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
  event.preventDefault();
  nativeWindowDrag = null;
  if (drag.target.hasPointerCapture(event.pointerId)) drag.target.releasePointerCapture(event.pointerId);
  // Wait for an actual drag, not a plain down/up, so the native move loop cannot
  // consume the second click that the user intended to maximize the window.
  void performNativeWindowAction("drag");
}, true);
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  document.addEventListener(type, () => { nativeWindowDrag = null; }, true);
}
window.addEventListener("blur", () => { nativeWindowDrag = null; });
windowChrome.addEventListener("dblclick", (event) => {
  if (event.button !== 0 || !event.target.matches("[data-window-drag]")) return;
  event.preventDefault();
  void performNativeWindowAction("toggle-maximize", windowMaximizeButton);
});
const windowDialogObserver = new MutationObserver((records) => {
  for (const { target, attributeName } of records) {
    if (attributeName !== "open" || target.tagName !== "DIALOG") continue;
    const previous = modalWindowStack.indexOf(target);
    if (previous >= 0) modalWindowStack.splice(previous, 1);
    if (target.open) modalWindowStack.push(target);
  }
  placeNativeWindowChrome();
});
windowDialogObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
window.addEventListener("media-tracker-window-state", (event) => {
  if (renderNativeWindowState(event.detail)) { placeNativeWindowChrome(); scheduleNativeWindowState(); }
});
window.addEventListener("focus", () => void queryNativeWindowState());
window.addEventListener("resize", () => void queryNativeWindowState());
renderNativeWindowState(window.__mediaTrackerWindowState);
placeNativeWindowChrome();
void queryNativeWindowState();
scheduleNativeWindowState();

function releasePersonUpdates() {
  pressedPersonId = null;
  const pending = [...deferredPersonUpdates];
  deferredPersonUpdates.clear();
  pending.forEach(updatePersonCard);
}

// Reconcile in place: a polling tick must never replace a pressed file button,
// focused control or native <details> element.
function reconcileElement(current, next) {
  if (current.tagName === "DETAILS" && current.dataset.jobId !== next.dataset.jobId) current.open = false;
  // Keep the text the user is reading/selecting until they close the details.
  if (!languageRefreshing && current.tagName === "UL" && current.parentElement?.matches("details.sync-errors[open]")) return;
  const pending = current.hasAttribute("data-action-pending");
  for (const attribute of [...current.attributes]) {
    if (attribute.name === "open" && current.tagName === "DETAILS") continue;
    if (pending && ["disabled", "data-action-pending"].includes(attribute.name)) continue;
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (pending && attribute.name === "disabled") continue;
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  if (pending && current.tagName === "BUTTON") return;
  const key = (node) => node.nodeType === Node.ELEMENT_NODE ? node.getAttribute("data-render-key") : null;
  const compatible = (left, right) => left && left.nodeType === right.nodeType
    && (left.nodeType !== Node.ELEMENT_NODE || left.tagName === right.tagName) && key(left) === key(right);
  const desired = [...next.childNodes];
  desired.forEach((child, index) => {
    let existing = current.childNodes[index];
    if (!compatible(existing, child)) {
      const match = key(child) ? [...current.childNodes].find((candidate) => compatible(candidate, child)) : null;
      if (match) {
        current.insertBefore(match, existing || null);
        existing = match;
      } else {
        current.insertBefore(child.cloneNode(true), existing || null);
        return;
      }
    }
    if (child.nodeType === Node.ELEMENT_NODE) reconcileElement(existing, child);
    else if (existing.nodeValue !== child.nodeValue) existing.nodeValue = child.nodeValue;
  });
  while (current.childNodes.length > desired.length) current.lastChild.remove();
}

function elementFromHtml(html) {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function setInterfaceHtml(element, html) {
  if (!languageRefreshing) {
    element.innerHTML = html;
    return;
  }
  const next = element.cloneNode(false);
  next.innerHTML = html;
  reconcileElement(element, next);
}

function acceptSyncSummary(job, expectedJobId) {
  if (!job || !state.persons.some((person) => person.id === job.personId)) return false;
  const previous = state.syncSummaries[job.personId];
  if (expectedJobId && (previous?.id !== expectedJobId || job.id !== expectedJobId)) return false;
  // An in-flight running response must not resurrect a cancelled/completed job.
  if (previous?.id === job.id && !["queued", "running"].includes(previous.status)
    && ["queued", "running"].includes(job.status)) return false;
  state.syncSummaries[job.personId] = previous?.id === job.id && previous.cancelRequested
    ? { ...job, cancelRequested: true } : job;
  syncSummaryVersions.set(job.personId, (syncSummaryVersions.get(job.personId) || 0) + 1);
  if (previous?.id !== job.id) {
    if (previous) {
      window.clearTimeout(syncPollTimers.get(previous.id));
      syncPollTimers.delete(previous.id);
    }
    state.newFilesByPerson.delete(job.personId);
    state.expandedNewFilePersonIds.delete(job.personId);
    if (state.contextFile?.personId === job.personId && state.contextFile.fileId) closeFileContextMenu();
  }
  return true;
}

function acceptStartedSync(job, previousJobId) {
  const current = state.syncSummaries[job.personId];
  if (current?.id !== previousJobId && current?.id !== job.id) return false;
  return acceptSyncSummary(job);
}

const elements = {
  navItems: [...document.querySelectorAll(".nav-item")],
  views: [...document.querySelectorAll(".view")],
  peopleList: document.querySelector("#people-list"),
  peopleSummary: document.querySelector("#people-summary"),
  createPersonButton: document.querySelector("#create-person-button"),
  syncAllButton: document.querySelector("#sync-all-button"),
  syncAllStatus: document.querySelector("#sync-all-status"),
  dedupAllButton: document.querySelector("#dedup-all-button"),
  dedupReceipt: document.querySelector("#dedup-receipt"),
  dedupJobStatus: document.querySelector("#dedup-job-status"),
  dedupStatus: document.querySelector("#dedup-status"),
  dedupProgress: document.querySelector("#dedup-progress"),
  dedupScanned: document.querySelector("#dedup-scanned"),
  dedupMerged: document.querySelector("#dedup-merged"),
  dedupReview: document.querySelector("#dedup-review"),
  dedupArchived: document.querySelector("#dedup-archived"),
  dedupDetails: document.querySelector("#dedup-details"),
  dedupResultList: document.querySelector("#dedup-result-list"),
  dedupCancelButton: document.querySelector("#dedup-cancel-button"),
  dedupContinueButton: document.querySelector("#dedup-continue-button"),
  dedupCloseButton: document.querySelector("#dedup-close-button"),
  personDialog: document.querySelector("#person-dialog"),
  personForm: document.querySelector("#person-form"),
  closeDialogButton: document.querySelector("#close-dialog-button"),
  cancelPersonButton: document.querySelector("#cancel-person-button"),
  personName: document.querySelector("#person-name"),
  personNote: document.querySelector("#person-note"),
  homepageUrl: document.querySelector("#homepage-url"),
  analyzeHomepageButton: document.querySelector("#analyze-homepage-button"),
  homepageStatus: document.querySelector("#homepage-status"),
  homepageCandidates: document.querySelector("#homepage-candidates"),
  selectedPath: document.querySelector("#selected-path"),
  pickFolderButton: document.querySelector("#pick-folder-button"),
  pathHint: document.querySelector("#path-hint"),
  folderModeOptions: document.querySelector("#folder-mode-options"),
  platformToAdd: document.querySelector("#platform-to-add"),
  personFollowingHint: document.querySelector("#person-following-page-hint"),
  personFollowingSettings: document.querySelector("#person-following-platform-settings"),
  addPlatformButton: document.querySelector("#add-platform-button"),
  platformEditor: document.querySelector("#platform-editor"),
  importFollowingButton: document.querySelector("#import-following-button"),
  followingDialog: document.querySelector("#following-import-dialog"),
  followingSource: document.querySelector("#following-import-source"),
  followingRead: document.querySelector("#read-following-import"),
  followingStop: document.querySelector("#stop-following-import"),
  followingStatus: document.querySelector("#following-import-status"),
  followingSettings: document.querySelector("#following-import-platform-settings"),
  followingSearch: document.querySelector("#following-import-search"),
  followingList: document.querySelector("#following-import-list"),
  followingSelectVisible: document.querySelector("#select-following-visible"),
  followingClear: document.querySelector("#clear-following-selection"),
  followingPage: document.querySelector("#following-import-page"),
  followingPrevious: document.querySelector("#previous-following-page"),
  followingNext: document.querySelector("#next-following-page"),
  followingSelected: document.querySelector("#following-import-selected"),
  followingApply: document.querySelector("#apply-following-import"),
  followingClose: document.querySelector("#close-following-import"),
  followingCancel: document.querySelector("#cancel-following-import"),
  platformDialog: document.querySelector("#platform-dialog"),
  platformForm: document.querySelector("#platform-form"),
  createPersonPlatformButton: document.querySelector("#create-person-platform-button"),
  createLinkedPlatformButton: document.querySelector("#create-linked-platform-button"),
  closePlatformDialog: document.querySelector("#close-platform-dialog"),
  cancelPlatformDialog: document.querySelector("#cancel-platform-dialog"),
  savePlatformButton: document.querySelector("#save-platform-button"),
  platformFormStatus: document.querySelector("#platform-form-status"),
  platformDialogTitle: document.querySelector("#platform-dialog-title"),
  customPlatformFolderHint: document.querySelector("#custom-platform-folder-hint"),
  customPlatformLabel: document.querySelector("#custom-platform-label"),
  customPlatformHomepage: document.querySelector("#custom-platform-homepage"),
  customPlatformLogin: document.querySelector("#custom-platform-login"),
  customPlatformFollowing: document.querySelector("#custom-platform-following"),
  customPlatformEngine: document.querySelector("#custom-platform-engine"),
  customPlatformVerification: document.querySelector("#custom-platform-verification"),
  customPlatformLoginMarker: document.querySelector("#custom-platform-login-marker"),
  customPlatformLogoutMarker: document.querySelector("#custom-platform-logout-marker"),
  folderTree: document.querySelector("#folder-tree"),
  formStatus: document.querySelector("#form-status"),
  savePersonButton: document.querySelector("#save-person-button"),
  dialogEyebrow: document.querySelector("#dialog-eyebrow"),
  dialogTitle: document.querySelector("#dialog-title"),
  linkedAccountForm: document.querySelector("#linked-account-form"),
  linkedPlatform: document.querySelector("#linked-platform"),
  linkedLabel: document.querySelector("#linked-label"),
  linkedAccountsList: document.querySelector("#linked-accounts-list"),
  themeControl: document.querySelector("#theme-control"),
  languageControl: document.querySelector("#language-control"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmPath: document.querySelector("#confirm-path"),
  confirmButton: document.querySelector("#confirm-button"),
  confirmAlternative: document.querySelector("#confirm-alternative"),
  confirmCancel: document.querySelector("#confirm-cancel"),
  recentPaths: document.querySelector("#recent-paths"),
  fileContextMenu: document.querySelector("#file-context-menu"),
  revealFileLocationButton: document.querySelector("#reveal-file-location"),
  viewFileSourcesButton: document.querySelector("#view-file-sources"),
  mediaDialog: document.querySelector("#media-dialog"),
  mediaDialogTitle: document.querySelector("#media-dialog-title"),
  closeMediaDialog: document.querySelector("#close-media-dialog"),
  mediaPersonPath: document.querySelector("#media-person-path"),
  mediaSearchForm: document.querySelector("#media-search-form"),
  mediaSearch: document.querySelector("#media-search"),
  refreshMediaList: document.querySelector("#refresh-media-list"),
  mediaListStatus: document.querySelector("#media-list-status"),
  mediaList: document.querySelector("#media-list"),
  mediaPageStatus: document.querySelector("#media-page-status"),
  mediaPreviousPage: document.querySelector("#media-previous-page"),
  mediaNextPage: document.querySelector("#media-next-page"),
  sourcesDialog: document.querySelector("#sources-dialog"),
  closeSourcesDialog: document.querySelector("#close-sources-dialog"),
  sourcesFileName: document.querySelector("#sources-file-name"),
  sourcesStatus: document.querySelector("#sources-status"),
  sourcesList: document.querySelector("#sources-list"),
  cachePreviewButton: document.querySelector("#cache-preview-button"),
  cacheCleanButton: document.querySelector("#cache-clean-button"),
  cacheRemoveProfilesButton: document.querySelector("#cache-remove-profiles-button"),
  cacheSelectedStatus: document.querySelector("#cache-selected-status"),
  cacheRemovalReceipt: document.querySelector("#cache-removal-receipt"),
  cacheSpaceLabel: document.querySelector("#cache-space-label"),
  cacheSpaceValue: document.querySelector("#cache-space-value"),
  cacheFilesLabel: document.querySelector("#cache-files-label"),
  cacheFilesValue: document.querySelector("#cache-files-value"),
  cacheProfilesValue: document.querySelector("#cache-profiles-value"),
  cacheStatus: document.querySelector("#cache-status"),
  cacheProfileList: document.querySelector("#cache-profile-list"),
  toast: document.querySelector("#toast"),
  toolsDialog: document.querySelector("#dedup-tools-dialog"),
  toolsSettings: document.querySelector("#dedup-tools-settings"),
  toolsSummary: document.querySelector("#dedup-tools-summary"),
  toolsStatus: document.querySelector("#dedup-tools-status"),
  toolsInstallPath: document.querySelector("#dedup-tools-install-path"),
  toolsInstallHint: document.querySelector("#dedup-tools-install-hint"),
  toolsExistingPath: document.querySelector("#dedup-tools-existing-path"),
  toolsInstall: document.querySelector("#dedup-tools-install"),
  toolsUseExisting: document.querySelector("#dedup-tools-use-existing"),
  toolsPickInstall: document.querySelector("#dedup-tools-pick-install"),
  toolsPickExisting: document.querySelector("#dedup-tools-pick-existing"),
  toolsCancel: document.querySelector("#dedup-tools-cancel"),
  toolsProgress: document.querySelector("#dedup-tools-progress"),
};

let toolsChoiceResolve;
let toolsBusy = false;
let toolsInstallAvailable = false;
let toolsFeatureMode = false;
let featureOfferPending = false;
let featureInstallSubmitting = false;
let featureCancelPending = false;
let featurePollTimer;
let featurePollInFlight = false;
let featureStatusVersion = 0;
let featureError = "";

function dedupFeatureUnavailable() {
  return state.features.dedup?.available === false;
}

function renderDedupFeatureProgress() {
  if (!toolsFeatureMode) return;
  const feature = state.features.dedup || {};
  const busy = featureInstallSubmitting || feature.installing === true;
  const progress = feature.progress || {};
  setToolsBusy(busy);
  elements.toolsInstallPath.disabled = true;
  elements.toolsPickInstall.disabled = true;
  elements.toolsCancel.disabled = featureCancelPending;
  elements.toolsCancel.textContent = busy
    ? featureCancelPending ? tr("正在取消下载…") : tr("取消下载") : tr("关闭");
  elements.toolsInstall.disabled = busy || feature.available === true || !feature.installAvailable;
  elements.toolsProgress.hidden = !busy;
  if (Number.isFinite(progress.bytes) && Number.isFinite(progress.totalBytes) && progress.totalBytes > 0) {
    elements.toolsProgress.value = Math.min(100, progress.bytes / progress.totalBytes * 100);
  } else elements.toolsProgress.removeAttribute("value");
  const message = featureError || (feature.available
    ? tr("去重工具包已验证。下次点击一键去重或资料去重即可开始；本次没有自动运行去重。")
    : tm(progress.message) || (busy ? tr("正在下载并校验工具包，采集内容和账号登录资料不会修改。")
      : tm(feature.message) || tr("相似去重尚未启用；媒体采集和精确 SHA-256 去重仍可使用。")));
  const bytes = busy && Number.isFinite(progress.bytes) && progress.bytes > 0
    ? ` ${formatBytes(progress.bytes)}${Number.isFinite(progress.totalBytes) && progress.totalBytes > 0 ? ` / ${formatBytes(progress.totalBytes)}` : ""}` : "";
  elements.toolsStatus.textContent = message + bytes;
  elements.toolsSummary.textContent = message;
}

function acceptDedupFeature(feature, expectedVersion) {
  if (!feature || typeof feature.available !== "boolean" || (expectedVersion !== undefined && expectedVersion !== featureStatusVersion)) return false;
  const wasAvailable = state.features.dedup?.available === true;
  state.features.dedup = feature;
  featureStatusVersion += 1;
  if (!feature.installing) featureCancelPending = false;
  if (feature.available) featureError = "";
  renderDedupControl();
  renderDedupFeatureProgress();
  if (!wasAvailable && feature.available && toolsFeatureMode) showToast(tr("去重工具包已验证，功能已启用。本次不会自动开始去重。"));
  ensureDedupFeaturePolling();
  return true;
}

function ensureDedupFeaturePolling(delay = 1000) {
  window.clearTimeout(featurePollTimer);
  if (appPageClosed || !state.features.dedup?.installing) return;
  featurePollTimer = window.setTimeout(() => void pollDedupFeature(), delay);
}

async function pollDedupFeature() {
  if (appPageClosed || featurePollInFlight) return;
  featurePollInFlight = true;
  const version = featureStatusVersion;
  try {
    const result = await api("/api/features/dedup");
    if (!appPageClosed) { featureError = ""; acceptDedupFeature(result, version); }
  } catch (error) {
    if (!appPageClosed) { featureError = tm(error.message); renderDedupFeatureProgress(); }
  } finally {
    featurePollInFlight = false;
    ensureDedupFeaturePolling(featureError ? 3000 : 1000);
  }
}

async function beginDedupFeatureInstall() {
  if (featureInstallSubmitting || state.features.dedup?.installing || appPageClosed) return;
  featureInstallSubmitting = true;
  featureError = "";
  renderDedupFeatureProgress();
  try {
    const feature = await api("/api/features/dedup/install", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    if (!appPageClosed && !acceptDedupFeature(feature)) throw new Error(tr("工具包准备状态无效，请检查后台版本后重试。"));
  } catch (error) {
    if (!appPageClosed) { featureError = tm(error.message); renderDedupFeatureProgress(); }
  } finally {
    featureInstallSubmitting = false;
    if (!appPageClosed) renderDedupFeatureProgress();
  }
}

async function cancelDedupFeatureInstall() {
  if (featureCancelPending || !state.features.dedup?.installing) return;
  featureCancelPending = true;
  renderDedupFeatureProgress();
  try {
    const feature = await api("/api/features/dedup/cancel", { method: "POST", body: JSON.stringify({ confirmed: true }) });
    if (!appPageClosed) acceptDedupFeature(feature);
  } catch (error) {
    featureCancelPending = false;
    featureError = tm(error.message);
    if (!appPageClosed) renderDedupFeatureProgress();
  }
}

async function confirmDedupFeatureDownload() {
  return requestConfirmation({ title: tr("当前无一键去重功能，是否需要下载工具包？"), tone: "neutral",
    confirmLabel: tr("是，下载工具包"), cancelLabel: tr("否，暂不下载"),
    message: tr("确认后从 Gyan 下载固定版本 FFmpeg 与 ffprobe（GPL-3.0-or-later），核对 SHA-256 后保存在本工具的 tools 中，并保留提供者的许可及来源说明。不是 MIT 组件；如再分发，需自行满足其 GPL 及对应源码义务。也可以取消后指定已有工具。不改系统设置、不上传媒体或登录信息，完成后不自动开始去重；精确去重不受影响。") });
}

async function offerDedupFeature() {
  if (featureOfferPending || featureInstallSubmitting || toolsBusy || elements.toolsDialog.open || appPageClosed) return;
  featureOfferPending = true;
  renderDedupControl();
  try {
    const feature = await api("/api/features/dedup");
    if (appPageClosed || !acceptDedupFeature(feature)) return;
    if (feature.available) return;
    if (!feature.installing && !await confirmDedupFeatureDownload()) return;
    if (appPageClosed) return;
    const status = await api("/api/tools/dedup");
    if (appPageClosed) return;
    void openToolsDialog(status, { featureMode: true });
    if (!feature.installing) await beginDedupFeatureInstall();
  } catch (error) { if (!appPageClosed) showToast(tm(error.message), true); }
  finally { featureOfferPending = false; if (!appPageClosed) renderDedupControl(); }
}

function renderToolsStatus(status) {
  toolsInstallAvailable = Boolean(status.installAvailable);
  const message = status.ready ? tr`组件可用：${status.directory}`
    : (tm(status.message) || tr("未找到可用组件；可以安装，或填写已有 FFmpeg 的 bin 文件夹。精确去重不受影响。"));
  elements.toolsStatus.textContent = message;
  elements.toolsSummary.textContent = message;
  if (toolsFeatureMode || !elements.toolsInstallPath.value) elements.toolsInstallPath.value = status.defaultInstallDirectory || "";
  if (!elements.toolsExistingPath.value) elements.toolsExistingPath.value = status.directory || "";
  elements.toolsInstall.disabled = toolsBusy || !toolsInstallAvailable;
}

function setToolsBusy(busy, message) {
  toolsBusy = busy;
  elements.toolsDialog.setAttribute("aria-busy", String(busy));
  for (const control of elements.toolsDialog.querySelectorAll("input,button")) control.disabled = busy;
  elements.toolsInstall.disabled = busy || !toolsInstallAvailable;
  if (message) elements.toolsStatus.textContent = message;
}

function openToolsDialog(status, { featureMode = false } = {}) {
  if (elements.toolsDialog.open) return Promise.resolve(false);
  toolsFeatureMode = featureMode;
  featureError = "";
  elements.toolsInstallHint.textContent = featureMode
    ? tr("最小版一键准备固定保存在采集工具的 tools 文件夹；也可以验证并使用其他位置的可信工具。")
    : tr("只在所选位置新建独立版本目录，不改注册表或系统 PATH，不覆盖已有工具。");
  renderToolsStatus(status);
  elements.toolsProgress.hidden = true;
  elements.toolsCancel.textContent = tr("暂不安装");
  if (featureMode) renderDedupFeatureProgress();
  elements.toolsDialog.returnValue = "cancel";
  elements.toolsDialog.showModal();
  elements.toolsExistingPath.focus();
  return new Promise((resolve) => { toolsChoiceResolve = resolve; });
}

async function ensureDedupTools() {
  const status = await api("/api/tools/dedup");
  renderToolsStatus(status);
  if (status.ready) return true;
  return openToolsDialog(status);
}

elements.toolsDialog.addEventListener("cancel", (event) => {
  if (toolsBusy) {
    event.preventDefault();
    if (toolsFeatureMode) void cancelDedupFeatureInstall();
  }
});
elements.toolsDialog.addEventListener("close", () => {
  toolsChoiceResolve?.(elements.toolsDialog.returnValue === "ready");
  toolsChoiceResolve = null;
});
elements.toolsCancel.addEventListener("click", () => {
  if (toolsFeatureMode && state.features.dedup?.installing) void cancelDedupFeatureInstall();
  else if (!toolsBusy) elements.toolsDialog.close("cancel");
});
elements.toolsSettings.addEventListener("click", async () => {
  elements.toolsSettings.disabled = true;
  try {
    await openToolsDialog(await api("/api/tools/dedup"), { featureMode: Boolean(state.features.dedup && !state.features.dedup.included) });
  }
  catch (error) { showToast(tm(error.message), true); }
  finally { elements.toolsSettings.disabled = false; }
});

async function chooseToolsFolder(field) {
  setToolsBusy(true, tr("等待选择文件夹…"));
  try {
    const result = await api("/api/folders/pick", { method: "POST", body: JSON.stringify({ initialPath: field.value.trim() }) });
    if (result.selectedPath) field.value = result.selectedPath;
    elements.toolsStatus.textContent = tr("请选择安装位置，或验证已有工具。");
  } catch (error) { elements.toolsStatus.textContent = tm(error.message); if (toolsFeatureMode) featureError = tm(error.message); }
  finally { setToolsBusy(false); if (toolsFeatureMode) renderDedupFeatureProgress(); }
}
elements.toolsPickInstall.addEventListener("click", () => chooseToolsFolder(elements.toolsInstallPath));
elements.toolsPickExisting.addEventListener("click", () => chooseToolsFolder(elements.toolsExistingPath));

async function configureDedupTools(install) {
  if (toolsBusy) return;
  if (install && toolsFeatureMode) {
    if (await confirmDedupFeatureDownload()) await beginDedupFeatureInstall();
    return;
  }
  if (install && !await requestConfirmation({ title: tr("下载并安装去重组件？"), tone: "neutral", confirmLabel: tr("确认下载并安装"),
    message: tr("确认后从 Gyan 下载固定版本 FFmpeg 与 ffprobe（GPL-3.0-or-later），核对 SHA-256 后保存在所选位置，并保留提供者的许可及来源说明。不是 MIT 组件；如再分发，需自行满足其 GPL 及对应源码义务。也可取消并指定已有工具。不改系统设置，不上传媒体或登录信息，下载完成前不开始去重。"), folderPath: elements.toolsInstallPath.value.trim() })) return;
  setToolsBusy(true, install ? tr("正在下载并校验组件，请稍候…") : tr("正在验证所选程序…"));
  try {
    const body = install ? { confirmed: true, parentDirectory: elements.toolsInstallPath.value.trim() || undefined }
      : { directory: elements.toolsExistingPath.value.trim() };
    const result = await api(install ? "/api/tools/dedup/install" : "/api/tools/dedup", { method: install ? "POST" : "PUT", body: JSON.stringify(body) });
    renderToolsStatus(result);
    if (!result.ready) throw new Error(tm(result.message) || tr("组件验证没有通过。请检查路径后重试。"));
    if (toolsFeatureMode) acceptDedupFeature(await api("/api/features/dedup"));
    elements.toolsDialog.close("ready");
    showToast(tr("去重组件已验证，可进行本地比对。"));
  } catch (error) { elements.toolsStatus.textContent = tm(error.message); if (toolsFeatureMode) featureError = tm(error.message); }
  finally { setToolsBusy(false); if (toolsFeatureMode) renderDedupFeatureProgress(); }
}
elements.toolsInstall.addEventListener("click", () => configureDedupTools(true));
elements.toolsUseExisting.addEventListener("click", () => configureDedupTools(false));

let localSessionPromise;
let publicUsePrompt;

async function localSession() {
  if (!localSessionPromise) {
    localSessionPromise = (async () => {
      const response = await fetch("/api/session", { cache: "no-store", credentials: "same-origin", redirect: "error" });
      const session = await response.json();
      if (!response.ok || session.applicationId !== "media-tracker-public"
        || typeof session.token !== "string" || !/^[a-f0-9]{64}$/.test(session.token)) {
        throw new Error(tr("无法验证公开版本地服务，请完整退出后从本版目录重新启动。"));
      }
      return session;
    })().catch((error) => { localSessionPromise = null; throw error; });
  }
  return localSessionPromise;
}

async function authenticatedApi(path, options = {}) {
  const session = await localSession();
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin", redirect: "error",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}),
      "X-Media-Tracker-Token": session.token },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(tm(payload.error) || tr`请求失败（${response.status}）`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

async function api(path, options = {}) {
  try { return await authenticatedApi(path, options); }
  catch (error) {
    if (error.status !== 428 || error.code !== "PUBLIC_USE_ACK_REQUIRED") throw error;
    if (!publicUsePrompt) {
      publicUsePrompt = (async () => {
        const confirmed = await requestConfirmation({ title: tr("公开版使用须知"), tone: "neutral",
          confirmLabel: tr("已阅读，继续操作"),
          message: tr("本版采用网页采集，尚未取得平台自动采集许可。请仅采集平台规则和作品权利许可允许的内容；能登录、能查看或能手动保存不代表获准自动采集。不得绕过验证码、DRM、付费或访问限制。平台仍可能限流或封号；若与自用版共享账号或 IP，两版可能同时受影响。确认仅表示已阅读风险，不授予许可或免除责任。") });
        if (!confirmed) throw new Error(tr("尚未确认使用须知，未执行联网操作。"));
        return authenticatedApi("/api/release-policy", { method: "POST", body: JSON.stringify({ acknowledged: true, version: 1 }) });
      })().finally(() => { publicUsePrompt = null; });
    }
    await publicUsePrompt;
    return authenticatedApi(path, options);
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message, isError = false) {
  elements.toast.textContent = tm(message);
  elements.toast.classList.toggle("is-error", isError);
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => elements.toast.classList.remove("is-visible"), 3200);
}

const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(preference) {
  const normalized = ["system", "light", "dark"].includes(preference) ? preference : "system";
  const resolved = normalized === "system" ? (systemTheme.matches ? "dark" : "light") : normalized;
  document.documentElement.dataset.themePreference = normalized;
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem("media-tracker-theme", normalized);
  document.querySelectorAll('input[name="theme"]').forEach((input) => { input.checked = input.value === normalized; });
}

function applyLanguage(preference) {
  window.MediaTrackerI18n?.setPreference(preference || "system", state.runtime.systemLanguage);
}

function refreshInterfaceLanguage() {
  languageRefreshing = true;
  try {
    // Reconcile existing nodes. Never reset a draft, close a dialog, fetch media,
    // or restart a sync just because the display language changed.
    renderPeople();
    renderLinkedAccounts();
    refreshPlatformOptions();
    if (elements.personDialog.open) {
      renderPlatformEditor();
      renderHomepageCandidates();
      renderFolderTree();
      updatePathHint();
    }
    if (elements.followingDialog.open) renderFollowingImport();
    if (state.cacheMaintenance.report) renderCacheReport();
    updateCacheControls();
    renderDedupControl();
    renderDedupFeatureProgress();
    if (nativeWindowState) renderNativeWindowState({ frameless: true, ...nativeWindowState });
    if (elements.mediaDialog.open && state.mediaBrowser) {
      const person = state.persons.find((item) => item.id === state.mediaBrowser.personId);
      if (person) elements.mediaDialogTitle.textContent = tr`${person.name} · 媒体与来源`;
      renderMediaPage();
    }
    if (elements.sourcesDialog.open && state.sourceBrowser?.sources) renderFileSources(state.sourceBrowser);
    for (const element of [elements.toast, elements.confirmTitle, elements.confirmMessage,
      elements.confirmButton, elements.confirmAlternative, elements.confirmCancel, elements.toolsCancel, elements.savePersonButton,
      elements.dialogTitle, elements.dialogEyebrow, elements.platformDialogTitle,
      elements.savePlatformButton, elements.analyzeHomepageButton, elements.pickFolderButton,
      elements.homepageStatus, elements.formStatus, elements.platformFormStatus,
      elements.cacheStatus, elements.toolsSummary, elements.toolsStatus, elements.toolsInstallHint]) {
      if (element) element.textContent = tm(element.textContent);
    }
    for (const button of document.querySelectorAll("button[data-action-pending]")) button.textContent = tm(button.textContent);
    for (const node of elements.cacheRemovalReceipt.querySelectorAll("strong, p")) {
      for (const text of [...node.childNodes].filter((child) => child.nodeType === Node.TEXT_NODE)) text.nodeValue = tm(text.nodeValue);
    }
  } finally { languageRefreshing = false; }
}

window.addEventListener("media-tracker-language-change", (event) => {
  if (event.detail.languageChanged) refreshInterfaceLanguage();
});

function confirmSystemLanguage(attempt = 0) {
  if (state.runtime.systemLanguage !== null || attempt >= 6 || appPageClosed) return;
  window.clearTimeout(systemLanguageTimer);
  systemLanguageTimer = window.setTimeout(async () => {
    try {
      const runtime = await api("/api/runtime/status");
      if (appPageClosed) return;
      if (["zh", "en"].includes(runtime.systemLanguage)) {
        state.runtime.systemLanguage = runtime.systemLanguage;
        applyLanguage(state.settings.language);
        return;
      }
    } catch {}
    confirmSystemLanguage(attempt + 1);
  }, 400);
}

function requestChoice({ title, message, confirmLabel = tr("确认移除"), cancelLabel = tr("取消"), alternativeLabel = "", folderPath = "", tone = "danger" }) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmPath.textContent = folderPath;
  elements.confirmPath.hidden = !folderPath;
  elements.confirmButton.textContent = confirmLabel;
  elements.confirmButton.classList.toggle("is-neutral", tone === "neutral");
  elements.confirmCancel.textContent = cancelLabel;
  elements.confirmAlternative.textContent = alternativeLabel;
  elements.confirmAlternative.hidden = !alternativeLabel;
  elements.confirmDialog.returnValue = "cancel";
  elements.confirmDialog.showModal();
  elements.confirmCancel.focus();
  return new Promise((resolve) => {
    elements.confirmDialog.addEventListener("close", () => resolve(elements.confirmDialog.returnValue), { once: true });
  });
}

async function requestConfirmation(options) {
  return await requestChoice(options) === "confirm";
}

async function deletePerson(person) {
  const confirmed = await requestConfirmation({
    title: tr`删除人物“${person.name}”？`,
    message: tr("确认后将移除此人物及其账号配置。下一步可以选择保留或删除已同步内容。"),
    confirmLabel: tr("确认删除人物"),
  });
  if (!confirmed) return;
  const choice = await requestChoice({
    title: tr("是否保留已同步内容？"),
    message: tr("“是”会保留文件，只移除人物记录；“否”将删除下方人物文件夹及其全部文件（含手动放入的文件），无法通过工具撤销。"),
    folderPath: person.folderPath,
    alternativeLabel: tr("是，保留内容"),
    confirmLabel: tr("否，删除全部文件"),
  });
  if (!["confirm", "alternative"].includes(choice)) return;
  state.deletingPersonIds.add(person.id);
  renderPeople();
  try {
    const result = await api(`/api/persons/${person.id}`, {
      method: "DELETE",
      body: JSON.stringify({ deleteFiles: choice === "confirm", expectedFolderPath: person.folderPath }),
    });
    const jobId = state.syncSummaries[person.id]?.id;
    if (jobId) {
      window.clearTimeout(syncPollTimers.get(jobId));
      syncPollTimers.delete(jobId);
    }
    state.expandedNewFilePersonIds.delete(person.id);
    state.newFilesByPerson.delete(person.id);
    delete state.syncSummaries[person.id];
    state.persons = state.persons.filter((item) => item.id !== person.id);
    if (state.contextFile?.personId === person.id) closeFileContextMenu();
    await refreshState();
    showToast(result.keptFiles ? tr("人物已删除，已同步内容保留在原文件夹。") : tr("人物及其文件夹内容已删除。"));
  } catch (error) {
    showToast(tm(error.message), true);
    await refreshState().catch(() => {});
  } finally {
    state.deletingPersonIds.delete(person.id);
    renderPeople();
  }
}

function switchView(viewName) {
  elements.navItems.forEach((item) => item.classList.toggle("is-active", item.dataset.view === viewName));
  elements.views.forEach((view) => view.classList.toggle("is-active", view.id === `${viewName}-view`));
  if (viewName === "cache" && !state.cacheMaintenance.report) scanCache();
}

function cacheHasCandidates(report) {
  return report?.totalFiles > 0 || report?.profiles?.some((profile) => profile.status !== "empty");
}

function updateCacheControls() {
  const { report, phase, loading, cleaning, removing, selectedProfiles } = state.cacheMaintenance;
  const busy = loading || cleaning || removing;
  elements.cachePreviewButton.disabled = busy;
  elements.cachePreviewButton.textContent = loading ? tr("扫描中…") : tr("扫描缓存");
  elements.cacheCleanButton.disabled = busy || phase !== "preview" || !cacheHasCandidates(report);
  elements.cacheCleanButton.textContent = cleaning ? tr("清理中…") : tr("清理缓存");
  const removable = new Set((report?.profiles || []).filter((profile) => !profile.linked
    && profile.removable === true && profile.removalId).map((profile) => profile.removalId));
  for (const id of selectedProfiles) if (!removable.has(id)) selectedProfiles.delete(id);
  elements.cacheRemoveProfilesButton.disabled = busy || selectedProfiles.size === 0;
  elements.cacheRemoveProfilesButton.textContent = removing ? tr("等待确认／删除中…") : tr("删除所选历史资料");
  elements.cacheSelectedStatus.textContent = selectedProfiles.size
    ? tr`已选 ${selectedProfiles.size} 个历史资料夹 · 将删除整个资料夹` : tr("未选择历史资料夹");
  elements.cacheProfileList.querySelectorAll("input[data-removal-id]").forEach((input) => {
    input.disabled = busy;
    input.checked = selectedProfiles.has(input.dataset.removalId);
  });
  elements.cacheProfileList.setAttribute("aria-busy", String(busy));
}

function setCacheStatus(message, isError = false) {
  elements.cacheStatus.textContent = tm(message);
  elements.cacheStatus.classList.toggle("is-error", isError);
}

function renderCacheReport() {
  const { report, phase } = state.cacheMaintenance;
  if (!report) return;
  const cleaned = phase === "clean";
  elements.cacheSpaceLabel.textContent = cleaned ? tr("实际已释放") : tr("预计可释放");
  elements.cacheFilesLabel.textContent = cleaned ? tr("已删除缓存文件") : tr("缓存文件");
  elements.cacheSpaceValue.textContent = formatBytes(cleaned ? report.removedBytes : report.totalBytes);
  elements.cacheFilesValue.textContent = (cleaned ? report.removedFiles : report.totalFiles).toLocaleString(uiLocale());
  elements.cacheProfilesValue.textContent = report.profiles.length.toLocaleString(uiLocale());
  const statusLabels = { ready: tr("可清理"), empty: tr("无缓存"), cleaned: tr("已清理"), skipped: tr("已跳过"), partial: tr("部分保留") };
  const inventoryErrors = [...new Set((report.errors || []).map((error) => tm(error.message)).filter(Boolean))];
  const warnings = inventoryErrors.length ? tr`<div class="cache-empty cache-inventory-warning">${inventoryErrors.map(escapeHtml).join("<br>")}<br>未通过检查的内容不会被当作空目录或强制清理。</div>` : "";
  setInterfaceHtml(elements.cacheProfileList, warnings + (report.profiles.length ? report.profiles.map((profile) => {
    const warning = ["skipped", "partial"].includes(profile.status);
    const details = [...new Set([tm(profile.message), tm(profile.removalReason), ...(profile.errors || []).map((error) => tm(error.message))].filter(Boolean))];
    const explanation = details.join(" ") || (warning ? tr("占用、路径或权限检查未通过，已保留相关缓存。") : "");
    const bytes = cleaned ? profile.removedBytes : profile.bytes;
    const files = cleaned ? profile.removedFiles : profile.files;
    return tr`<article class="cache-profile-row">
      <div><div class="cache-profile-heading"><h3>${escapeHtml(profile.accountLabel)}</h3><span class="platform-tag">${escapeHtml(profile.platformLabel)}</span></div>
        <small class="cache-profile-id">资料夹 ID：${escapeHtml(profile.profileId)}${profile.linked ? "" : tr(" · 当前未绑定")}</small>
        ${explanation ? `<p class="cache-profile-message${warning ? " is-warning" : ""}">${escapeHtml(explanation)}</p>` : ""}
        ${profile.linked ? tr('<span class="cache-profile-protected">当前绑定 · 登录资料受保护</span>')
          : profile.removable === true && profile.removalId
            ? tr`<label class="cache-profile-select"><input type="checkbox" data-removal-id="${escapeHtml(profile.removalId)}" /><span>选择删除历史资料夹${Number.isSafeInteger(profile.profileBytes) ? tr`（全部资料 ${formatBytes(profile.profileBytes)}）` : ""}</span></label>`
            : tr('<p class="cache-history-hint">暂不可删除历史资料；解决上方占用或检查限制后，请重新扫描。</p>')}
      </div>
      <div class="cache-profile-size"><strong>${formatBytes(bytes || 0)}</strong><small>${cleaned ? tr("删除 ") : ""}${Number(files || 0).toLocaleString(uiLocale())} 个文件 · ${escapeHtml(statusLabels[profile.status] || tr("已保留"))}</small></div>
    </article>`;
  }).join("") : tr('<div class="cache-empty">没有找到可安全处理的登录资料夹。尚未登录平台时，无需清理；无法读取或包含目录链接的资料夹不会参与删除。</div>')));
  updateCacheControls();
}

async function scanCache() {
  const cache = state.cacheMaintenance;
  if (cache.loading || cache.cleaning || cache.removing) return;
  cache.loading = true;
  updateCacheControls();
  setCacheStatus(tr("正在扫描普通缓存；仅检查文件信息，不会删除文件。资料较多时请稍候。"));
  try {
    cache.report = await api("/api/cache/preview");
    cache.phase = "preview";
    renderCacheReport();
    const limited = cache.report.profiles.filter((profile) => ["partial", "skipped"].includes(profile.status)).length;
    const errors = cache.report.errors?.length || 0;
    if (!cacheHasCandidates(cache.report) && !errors) {
      setCacheStatus(tr("扫描完成，当前没有可清理的缓存，无需清理。"));
    } else {
      setCacheStatus(tr`扫描完成，${cache.report.totalFiles.toLocaleString(uiLocale())} 个缓存文件，预计可释放 ${formatBytes(cache.report.totalBytes)}。${limited || errors ? tr` 存在${limited ? tr` ${limited} 个资料夹的占用或读取限制` : tr("目录读取限制")}，请查看下方原因；清理时会再次检查，无法安全处理的部分将保留。` : tr(" 点击“清理缓存”后还需确认，实际释放量以清理结果为准。")}`);
    }
  } catch (error) {
    setCacheStatus(error.status === 404
      ? tr("后台服务还是旧版本。请停止同步后，完全停止本目录 server.mjs 对应的旧版后台服务，再通过采集工具快捷方式重新启动一次；旧版仅关闭主窗口再打开不会更新后台。新版本关闭主窗口会自动完整退出。")
      : tr`扫描未完成：${tm(error.message)}。可稍后点击“扫描缓存”重试。`, true);
  } finally {
    cache.loading = false;
    updateCacheControls();
  }
}

async function cleanCache() {
  const cache = state.cacheMaintenance;
  if (cache.loading || cache.cleaning || cache.removing || cache.phase !== "preview" || !cacheHasCandidates(cache.report)) return;
  cache.cleaning = true;
  updateCacheControls();
  try {
    const confirmed = await requestConfirmation({
      title: tr("清理普通缓存？"),
      message: tr`预计可释放 ${formatBytes(cache.report.totalBytes)}。仅删除可重建的浏览器缓存，不进回收站；登录信息、同步索引和下载媒体均保留。正在使用或无法安全检查的资料夹会跳过。`,
      confirmLabel: tr("清理缓存"),
    });
    if (!confirmed) { setCacheStatus(tr("已取消清理，没有删除文件。可以继续扫描或清理。")); return; }
    setCacheStatus(tr("正在安全清理普通缓存；不会关闭登录窗口或中断同步，请稍候。"));
    cache.report = await api("/api/cache/clean", { method: "POST", body: JSON.stringify({ confirm: true }) });
    cache.phase = "clean";
    renderCacheReport();
    const limited = cache.report.profiles.filter((profile) => ["partial", "skipped"].includes(profile.status)).length;
    const incomplete = cache.report.status === "partial" || limited > 0;
    setCacheStatus(tr`已删除 ${cache.report.removedFiles.toLocaleString(uiLocale())} 个缓存文件，实际释放 ${formatBytes(cache.report.removedBytes)}。${incomplete ? tr` ${limited ? tr`${limited} 个资料夹未完全清理` : tr("部分目录未通过安全检查")}，相关缓存已保留；请查看下方原因，结束同步或关闭登录窗口后重新扫描。` : tr(" 登录信息、索引和媒体均未纳入删除范围。需要再次清理时，请先重新扫描。")}`);
    showToast(incomplete ? tr("缓存清理已结束，部分占用或异常项已保留。") : tr("缓存清理已完成。"));
  } catch (error) {
    setCacheStatus(tr`清理未完成：${tm(error.message)}。请重新扫描确认当前缓存情况。`, true);
  } finally {
    cache.cleaning = false;
    updateCacheControls();
  }
}

async function removeUnlinkedProfiles() {
  const cache = state.cacheMaintenance;
  if (cache.loading || cache.cleaning || cache.removing || !cache.selectedProfiles.size) return;
  const selected = (cache.report?.profiles || []).filter((profile) => !profile.linked
    && profile.removable === true && cache.selectedProfiles.has(profile.removalId));
  if (!selected.length) return;
  cache.removing = true;
  updateCacheControls();
  try {
    const description = selected.map((profile) => `${profile.platformLabel} · ${profile.profileId}`).join("\n");
    if (!await requestConfirmation({
      title: tr`删除所选历史资料夹（${selected.length}）？`,
      message: tr("仅处理所选、未被当前绑定使用的历史资料夹。当前绑定的账号不删除；采集媒体、人物与同步索引不受影响。请核对下方资料夹。"),
      folderPath: description, confirmLabel: tr("继续确认"),
    })) return;
    if (!await requestConfirmation({
      title: tr("永久删除所选历史资料？"),
      message: tr("将删除这些历史资料夹及其全部文件，包括旧尝试登录留下的 Cookie、网站存储和设置。不进回收站，不能撤销。这与只删除普通缓存不同；如果仍需使用其中的登录资料，请取消。"),
      folderPath: description, confirmLabel: tr("永久删除所选资料"),
    })) return;
    setCacheStatus(tr("正在再次检查绑定、浏览器占用和目录安全；只删除所选历史资料，请稍候。"));
    const result = await api("/api/cache/remove-unlinked-profiles", {
      method: "POST", body: JSON.stringify({ confirm: true, profileIds: selected.map((profile) => profile.removalId) }),
    });
    const results = new Map(result.profiles.map((profile) => [profile.removalId, profile]));
    cache.report.profiles = cache.report.profiles.flatMap((profile) => {
      const receipt = results.get(profile.removalId);
      if (!receipt) return [profile];
      if (receipt.status === "removed") return [];
      return [{ ...profile, linked: receipt.linked, removable: false, removalId: null,
        message: tm(receipt.message) || tr("历史资料删除未完成，请查看回执并重新扫描。"), status: "skipped" }];
    });
    const totalBytesKey = cache.phase === "clean" ? "removedBytes" : "totalBytes";
    const totalFilesKey = cache.phase === "clean" ? "removedFiles" : "totalFiles";
    // A prior ordinary-cache cleanup receipt describes that completed operation;
    // history removal must not rewrite how much it had already cleaned.
    if (cache.phase !== "clean") {
      cache.report[totalBytesKey] = cache.report.profiles.reduce((sum, profile) => sum + Number(profile.bytes || 0), 0);
      cache.report[totalFilesKey] = cache.report.profiles.reduce((sum, profile) => sum + Number(profile.files || 0), 0);
    }
    cache.selectedProfiles.clear();
    renderCacheReport();
    const incomplete = result.status === "partial";
    const summary = tr`已删除 ${result.removedProfiles} 个历史资料夹，删除文件 ${result.removedFiles} 个，释放 ${formatBytes(result.removedBytes)}。${incomplete ? tr(" 部分资料未能删除，请查看下方回执。") : tr(" 当前绑定账号的登录信息、采集媒体和索引均保留。")}`;
    const details = result.profiles.filter((profile) => profile.status !== "removed").map((profile) =>
      `<p>${escapeHtml(profile.platformLabel)} · ${escapeHtml(profile.profileId)}：${escapeHtml(tm(profile.message) || tr("未删除，请重新扫描后重试。"))}${profile.remainingPath ? tr`<br>剩余文件位置：${escapeHtml(profile.remainingPath)}` : ""}</p>`).join("");
    const warnings = [...new Set((result.errors || []).map((error) => tm(error.message)).filter(Boolean))]
      .map((message) => `<p>${escapeHtml(message)}</p>`).join("");
    setInterfaceHtml(elements.cacheRemovalReceipt, `<strong>${escapeHtml(summary)}</strong>${details}${warnings}`);
    elements.cacheRemovalReceipt.hidden = false;
    setCacheStatus(summary, incomplete);
    showToast(incomplete ? tr("历史资料删除部分完成，请查看回执。") : tr("所选历史资料已删除。"));
  } catch (error) {
    setCacheStatus(error.status === 404 ? tr("后台尚未加载历史资料删除功能，请完全关闭工具后重新打开；未执行删除。")
      : tr`历史资料删除未完成：${tm(error.message)}。请重新扫描确认当前资料；不会自动重试删除。`, true);
  } finally {
    cache.removing = false;
    updateCacheControls();
  }
}

function platformOptions(selected = "") {
  return Object.entries(state.platforms)
    .map(([id, platform]) => `<option value="${escapeHtml(id)}" ${id === selected ? "selected" : ""}>${escapeHtml(platform.label)}${platform.custom ? tr(" · 自定义") : ""}</option>`)
    .join("");
}

function refreshPlatformOptions({ personSelection = elements.platformToAdd.value, linkedSelection = elements.linkedPlatform.value } = {}) {
  setInterfaceHtml(elements.platformToAdd, platformOptions(personSelection));
  setInterfaceHtml(elements.linkedPlatform, platformOptions(linkedSelection));
  renderPersonFollowingHint();
}

function customFollowingPageMissing(platformId) {
  const platform = state.platforms[platformId];
  return Boolean(platform?.custom && !String(platform.followingUrl || "").trim());
}

function renderPersonFollowingHint() {
  elements.personFollowingHint.hidden = !customFollowingPageMissing(elements.platformToAdd.value);
}

function openCustomPlatformDialog(source, platformId = null, trigger = null) {
  if (state.creatingPlatform) return;
  const platform = platformId ? state.platforms[platformId] : null;
  if (platformId && !platform?.custom) return;
  state.customPlatformSource = source;
  state.editingPlatformId = platformId;
  state.customPlatformTrigger = trigger || document.activeElement;
  elements.platformForm.reset();
  elements.customPlatformLabel.value = platform?.label || "";
  elements.customPlatformHomepage.value = platform?.homepageUrl || "";
  elements.customPlatformHomepage.readOnly = Boolean(platform);
  elements.customPlatformLogin.value = platform?.loginUrl || "";
  elements.customPlatformFollowing.value = platform?.followingUrl || "";
  elements.customPlatformEngine.querySelector('[data-legacy-gallery]')?.remove();
  if (platform?.engine === "gallery-dl") {
    const option = new Option(tr("gallery-dl（发行版未集成，请改选）"), "gallery-dl", false, true);
    option.disabled = true;
    option.dataset.legacyGallery = "true";
    elements.customPlatformEngine.append(option);
  }
  elements.customPlatformEngine.value = platform?.engine || "auto";
  elements.customPlatformVerification.value = platform?.verificationUrl || "";
  elements.customPlatformLoginMarker.value = platform?.loginMarker || "";
  elements.customPlatformLogoutMarker.value = platform?.logoutMarker || "";
  elements.customPlatformFolderHint.hidden = !platform;
  elements.platformDialogTitle.textContent = platform ? tr("自定义平台设置") : tr("添加自定义平台");
  elements.savePlatformButton.textContent = platform ? tr("保存平台设置") : tr("创建平台");
  elements.platformFormStatus.textContent = "";
  elements.platformForm.querySelector("details").open = Boolean(platform);
  elements.platformDialog.showModal();
  elements.customPlatformLabel.focus();
}

function closeCustomPlatformDialog() {
  if (state.creatingPlatform) return;
  elements.platformDialog.close();
  const source = state.customPlatformSource;
  const trigger = state.customPlatformTrigger;
  state.customPlatformSource = null;
  state.editingPlatformId = null;
  state.customPlatformTrigger = null;
  if (elements.followingDialog.open) renderFollowingImport();
  (trigger?.isConnected ? trigger : source === "person" ? elements.createPersonPlatformButton : elements.createLinkedPlatformButton).focus();
}

function linkedAccountOptions(platformId, selected = "") {
  const accounts = state.linkedAccounts.filter((account) => account.platformId === platformId);
  return [
    tr`<option value="">不登录，仅尝试公开内容</option>`,
    ...accounts.map((account) => {
      const status = account.loginStatus === "verified" ? tr("已验证") : account.loginCode === "login-rule-required" ? tr("验证待配置") : tr("未验证");
      return `<option value="${escapeHtml(account.id)}" ${account.id === selected ? "selected" : ""}>${escapeHtml(account.label)}（${status}）</option>`;
    }),
  ].join("");
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function syncIssues(job) {
  const legacyWarnings = (job?.errors || []).filter((item) => item.code === "timeline-incomplete");
  const warnings = [...(job?.warnings || []), ...legacyWarnings];
  const nonActionable = (item) => ["history", "attachments", "posts"].includes(item.category)
    || ["timeline-incomplete", "history-verification-pending", "post-verification-pending"].includes(item.code);
  return {
    errors: (job?.errors || []).filter((item) => item.code !== "timeline-incomplete"),
    warnings: warnings.filter((item) => !nonActionable(item)),
    technicalRecords: warnings.filter(nonActionable),
    failed: Math.max(0, Number(job?.counters?.failed || 0) - legacyWarnings.length),
    warningCount: warnings.filter((item) => !nonActionable(item)).length,
    legacyWarningCount: legacyWarnings.length,
  };
}

function syncStatusLabel(job) {
  if (!job) return tr("尚未同步");
  if (job.status === "queued") return tr("排队等待");
  if (job.status === "running") return tr("正在同步");
  if (job.status === "completed" && syncIssues(job).failed) return tr("完成但有失败");
  if (job.status === "completed" && syncIssues(job).warningCount) return tr("完成 · 有处理提示");
  return ({ completed: tr("同步完成"), failed: tr("同步失败"), cancelled: tr("已取消") })[job.status] || tr("等待同步");
}

function pendingPostAccount(person, account) {
  const normalizedLabel = (value) => String(value || "").trim().replace(/^@/, "").toLocaleLowerCase();
  const platform = person.platforms.find((item) => item.id === account.platformId
    || (!account.platformId && normalizedLabel(item.label || state.platforms[item.id]?.label) === normalizedLabel(account.platform)));
  const matches = platform?.accounts.filter((item) => item.id === account.accountId
    || (!account.accountId && normalizedLabel(item.label) === normalizedLabel(account.account))) || [];
  return matches.length === 1 ? { platformId: platform.id, accountId: matches[0].id } : null;
}

function renderPendingPostDetails(job, person) {
  const accounts = Array.isArray(job?.accountResults) ? job.accountResults : [];
  return accounts.flatMap((account) => {
    const samples = Array.isArray(account?.diagnostics?.pendingPostSamples) ? account.diagnostics.pendingPostSamples.slice(0, 5) : [];
    return samples.map((post) => {
      const url = safeSourceUrl(post?.postUrl);
      const accountReference = pendingPostAccount(person, account);
      const postId = typeof post?.postId === "string" ? post.postId : "";
      const counts = Number.isFinite(post?.knownCount) && Number.isFinite(post?.expectedCount)
        ? tr`已识别 ${post.knownCount} / 预期 ${post.expectedCount} 个附件`
        : Number.isFinite(post?.expectedCount) ? tr`预期 ${post.expectedCount} 个附件 · 已识别数量未知`
          : Number.isFinite(post?.knownCount) ? tr`已识别 ${post.knownCount} 个附件 · 预期数量未知` : tr("附件数量未记录");
      const control = url && accountReference && postId ? tr` <button class="sync-post-link open-bound-post" type="button" data-person-id="${escapeHtml(person.id)}" data-platform-id="${escapeHtml(accountReference.platformId)}" data-account-id="${escapeHtml(accountReference.accountId)}" data-post-id="${escapeHtml(postId)}" data-render-key="post:${escapeHtml(accountReference.platformId)}:${escapeHtml(accountReference.accountId)}:${escapeHtml(postId)}" title="使用此账号当前绑定的独立登录窗口查看">查看原帖 ↗</button>` : url ? tr(" · 原帖账号映射已移除") : tr(" · 原帖链接未记录");
      return tr`<li><strong>${escapeHtml([account.platform, account.account].filter(Boolean).join(" · "))} · 帖子 ${escapeHtml(String(post?.postId || tr("标识未知")))}</strong><span>${escapeHtml(counts)}${control}</span></li>`;
    });
  }).slice(0, 20).join("");
}

function localizedQueueReason(job) {
  if (window.MediaTrackerI18n?.language === "en" && Array.isArray(job?.queueWaiting) && job.queueWaiting.length) {
    return job.queueWaiting.map((item) => item.reason === "earlier-job"
      ? `Waiting in queue for ${item.personName || "an earlier task"} to release ${item.platform}`
      : item.personName ? `Waiting for ${item.personName} to release ${item.platform}`
        : `Waiting for ${item.platform} login, verification or maintenance to finish`).join("; ");
  }
  return tm(job?.queueReason) || tr("等待对应登录会话空闲，按提交顺序处理共享资源。");
}

function localizedSyncMessage(job, person) {
  if (job?.status === "queued" && Array.isArray(job.queueWaiting)) {
    return `${Number.isInteger(job.queuePosition) && job.queuePosition > 0 ? tr`队列第 ${job.queuePosition} 位` : tr("排队等待")} · ${localizedQueueReason(job)}`;
  }
  const candidates = (person?.platforms || []).flatMap((platform) => (platform.accounts || []).map((account) => ({
    platformLabel: state.platforms[platform.id]?.label || platform.label, accountLabel: account.label,
  }))).filter((item) => `${item.platformLabel} · ${item.accountLabel}` === job?.currentAccount);
  return tm(job?.message, candidates.length === 1 ? candidates[0] : undefined);
}

function renderSyncReceipt(person) {
  const job = state.syncSummaries[person.id];
  const counters = job?.counters || {};
  const active = ["queued", "running"].includes(job?.status);
  const issues = syncIssues(job);
  const duplicateCount = Number(counters.logicalDuplicates || 0) + Number(counters.contentDuplicates || 0);
  const totalAccounts = Number(counters.accounts || 0);
  const finishedAccounts = Number(counters.accountsFinished || 0);
  const pausedAccounts = safeDedupCount(counters.pausedAccounts);
  const accountProgress = Array.isArray(job?.accountProgress) ? job.accountProgress : [];
  const accountActivityParts = [];
  // An empty array during setup is not evidence that no account is running.
  // Show task counts only once the scheduler has published its account tasks.
  if (active && accountProgress.length) {
    accountActivityParts.push(tr`${accountProgress.filter((account) => account.status === "running").length} 个账号运行`);
    accountActivityParts.push(tr`${accountProgress.filter((account) => account.status === "queued").length} 个账号等待`);
  }
  if (pausedAccounts) accountActivityParts.push(tr`${pausedAccounts} 个账号已暂停`);
  const allAccountsPaused = totalAccounts === 0 && pausedAccounts > 0;
  const progress = job?.status === "completed"
    ? 100
    : (totalAccounts ? Math.min(100, Math.round((finishedAccounts / totalAccounts) * 100)) : 0);
  const errorItems = [...issues.errors.map((item) => ({ ...item, issueLabel: tr("失败") })),
    ...issues.warnings.map((item) => ({ ...item, issueLabel: tr("处理提示") }))].map((item) =>
    `<li><strong>${escapeHtml([item.platform, item.account].filter(Boolean).join(" · ") || tr("任务"))} · ${item.issueLabel}</strong><span>${escapeHtml(tm(item.message))}</span></li>`).join("");
  const technicalItems = issues.technicalRecords.slice(-6).map((item) => `<li><strong>${escapeHtml([item.platform, item.account].filter(Boolean).join(" · ") || tr("平台记录"))}</strong><span>${escapeHtml(tm(item.message))}</span></li>`).join("") + renderPendingPostDetails(job, person);
  const receiptMessage = job?.status === "completed"
    ? allAccountsPaused ? tr("全部账号已暂停，本次未读取平台或修改增量节点。")
      : issues.failed ? tr`已采集可读取内容；${issues.failed} 项下载或访问失败将在下次增量同步重试，已保存文件保留。`
      : issues.warningCount ? tr("已采集可读取内容；本地整理提示见下方，媒体已保留。") : tr("已采集本轮可读取内容，下次以上次成功节点增量添加。")
    : localizedSyncMessage(job, person);
  const finishedAt = job?.finishedAt ? new Date(job.finishedAt).toLocaleString(uiLocale()) : "";
  return tr`
    <section class="sync-receipt is-${escapeHtml(job?.status || "idle")} ${active ? "is-live" : ""} ${issues.failed ? "has-failures" : ""}">
      <div class="sync-receipt-head">
        <div><strong>同步回执</strong><small ${job?.currentAccount ? "" : "hidden"}>${escapeHtml(job?.currentAccount || "")}</small></div>
        <span class="sync-status">${syncStatusLabel(job)}</span>
      </div>
      <p>${escapeHtml(job ? (receiptMessage || tr("等待同步。")) : tr("首次同步会读取支持平台的历史媒体并建立本地去重索引；Threads 暂待接入。"))}</p>
      ${job?.status === "queued" ? `<p class="sync-queue-reason">${escapeHtml([Number.isInteger(job.queuePosition) && job.queuePosition > 0 ? tr`队列第 ${job.queuePosition} 位` : tr("排队等待"), localizedQueueReason(job)].join(" · "))}</p>` : ""}
      <div class="sync-account-progress" data-render-key="account-progress:${escapeHtml(person.id)}" ${accountActivityParts.length ? "" : "hidden"}>${escapeHtml(accountActivityParts.join(" · "))}</div>
      <progress class="sync-progress" aria-label="同步进度" value="${progress}" max="100" ${job ? "" : 'hidden style="display:none"'}></progress>
      <div class="sync-metrics" ${job ? "" : 'hidden style="display:none"'}>
        <span><b>${Number(counters.discovered || 0)}</b>发现</span>
        <span><b>${Number(counters.downloaded || 0)}</b>新增</span>
        <span><b>${duplicateCount}</b>去重</span>
        <span><b>${issues.failed}</b>失败</span>
      </div>
      <div class="sync-footnote" ${job ? "" : 'hidden style="display:none"'}>
        <span>${finishedAt ? tr`最后更新 ${escapeHtml(finishedAt)}` : tr`账号进度 ${finishedAccounts}/${totalAccounts}`}</span>
        <span>${formatBytes(counters.bytes)}${counters.unsupportedAccounts ? tr` · ${counters.unsupportedAccounts} 个待接入平台已跳过` : ""}</span>
      </div>
      ${job?.deduplication?.skipped ? `<p class="sync-dedup-summary">${escapeHtml(tm(job.deduplication.message))}</p>` : job?.deduplication ? tr`<p class="sync-dedup-summary">本地自动去重 · 已合并 ${safeDedupCount(job.deduplication.merged)} · 疑似项保留 ${safeDedupCount(job.deduplication.review)} · 可恢复归档 ${formatBytes(safeDedupCount(job.deduplication.archivedBytes))}</p>${job.deduplication.reviewItems?.length ? tr`<details class="sync-errors sync-dedup-details" data-job-id="${escapeHtml(job?.id || "")}"><summary>查看去重疑似项</summary><ul>${renderDedupReviewItems(job.deduplication.reviewItems, person.id)}</ul><p class="field-hint">疑似项已经保存，没有自动合并，不影响采集完成。音轨不同等版本按保留规则同时留下，不需要当作下载失败处理。单击文件名用系统程序检查，右键可定位或查看来源。展开期间保留当前结果，收起后重新展开可查看最新内容。</p></details>` : ""}` : ""}
      <details class="sync-errors sync-operational-errors" data-job-id="${escapeHtml(job?.id || "")}" ${errorItems ? "" : "hidden"}><summary>查看提示与失败原因</summary><div class="sync-detail-actions"><button class="secondary-button copy-sync-details" type="button" data-render-key="copy-errors:${escapeHtml(job?.id || "")}">复制报错</button></div><ul>${errorItems}</ul><p class="field-hint">下载、网络、登录及本地整理错误会保留；下次增量同步会重试失败项，不重新下载已有完整文件。展开期间保留当前提示；收起后重新展开可查看最新内容。</p></details>
      ${job ? tr`<details class="sync-errors sync-technical-records" data-job-id="${escapeHtml(job?.id || "")}"><summary>技术记录（无需处理）</summary><p class="field-hint">已采集可读取内容，未返回内容自动保留记录，不作为人工待办。常规同步只增量添加；完整补查仅在你主动选择时执行。</p><div class="sync-detail-actions" ${technicalItems ? "" : "hidden"}><button class="secondary-button copy-sync-details" type="button" data-render-key="copy-records:${escapeHtml(job?.id || "")}">复制技术记录</button></div><ul>${technicalItems}</ul><button class="secondary-button recheck-person" type="button" data-person-id="${escapeHtml(person.id)}" ${active || dedupBusy() || state.deletingPersonIds.has(person.id) ? "disabled" : ""}>手动完整补查</button><p class="field-hint">仅此操作重新读取全部账号历史，已有完整文件跳过，不重置索引。</p></details>` : ""}
    </section>`;
}

function newFileKindLabel(kind) {
  return ({ image: tr("图片"), video: tr("视频"), gif: tr("动图") })[kind] || tr("文件");
}

function renderNewFiles(person) {
  const job = state.syncSummaries[person.id];
  const expanded = state.expandedNewFilePersonIds.has(person.id);
  const cached = state.newFilesByPerson.get(person.id);
  const cacheMatches = Boolean(job && cached?.jobId === job.id);
  const hasCount = Boolean(job && Object.hasOwn(job, "newFileCount"));
  const count = hasCount ? Number(job.newFileCount || 0) : null;
  let content = "";

  if (expanded) {
    if (!cacheMatches || (cached.loading && !cached.loadedFor)) {
      content = tr`<div class="new-files-empty">正在读取本次新增清单…</div>`;
    } else if (cached.error) {
      content = `<div class="new-files-empty is-error">${escapeHtml(cached.error)}</div>`;
    } else if (!cached.available) {
      content = tr`<div class="new-files-empty">当前是旧版同步回执，没有保存文件明细。完成下一次同步后即可在这里查看。</div>`;
    } else if (cached.files.length === 0) {
      content = tr`<div class="new-files-empty">本次同步没有新增文件。</div>`;
    } else {
      content = `<ol class="new-files-list">${cached.files.map((file) => tr`
        <li class="new-file-row" data-render-key="${escapeHtml(file.id)}">
          <span class="new-file-kind is-${escapeHtml(file.kind)}">${newFileKindLabel(file.kind)}</span>
          <button class="new-file-name" type="button" aria-haspopup="menu" data-person-id="${escapeHtml(person.id)}" data-file-id="${escapeHtml(file.id)}" data-media-id="${escapeHtml(file.mediaId || "")}" title="单击使用系统默认程序打开；右键打开文件菜单">${escapeHtml(file.filename)}</button>
          <span class="new-file-source">${escapeHtml(file.platformLabel)} · ${escapeHtml(file.accountLabel)}</span>
          <button class="file-sources-button" type="button" data-person-id="${escapeHtml(person.id)}" data-media-id="${escapeHtml(file.mediaId || "")}" data-filename="${escapeHtml(file.filename)}" ${file.mediaId ? "" : tr('disabled title="旧版回执不包含来源索引，请完成一次新同步"')}>查看来源</button>
        </li>`).join("")}</ol>`;
    }
  }

  return tr`
    <section class="new-files-drawer ${expanded ? "is-expanded" : ""}">
      <button class="new-files-toggle" type="button" data-person-id="${escapeHtml(person.id)}" aria-expanded="${expanded}" ${job ? "" : "disabled"}>
        <span>查看新增</span>
        <b>${hasCount ? count : (job ? tr("旧回执") : "0")}</b>
        <i aria-hidden="true">⌄</i>
      </button>
      <div class="new-files-panel" ${expanded ? "" : "hidden"}>${content}<p class="new-files-hint">单击文件名用系统程序打开；右键可定位文件或查看全部来源。</p></div>
    </section>`;
}

async function loadNewFiles(personId) {
  const job = state.syncSummaries[personId];
  if (!job) return;
  const previous = state.newFilesByPerson.get(personId);
  if (previous?.jobId === job.id && previous.loading) {
    updatePersonCard(personId);
    return;
  }
  const loadedFor = newFilesVersion(job);
  const request = {
    ...(previous?.jobId === job.id ? previous : { available: true, files: [] }),
    jobId: job.id, loading: true, error: "",
  };
  state.newFilesByPerson.set(personId, request);
  updatePersonCard(personId);
  const isCurrent = () => state.persons.some((person) => person.id === personId)
    && state.syncSummaries[personId]?.id === job.id && state.newFilesByPerson.get(personId) === request;
  try {
    const receipt = await api(`/api/persons/${personId}/new-files`);
    if (!isCurrent()) return;
    if (receipt.jobId && receipt.jobId !== job.id) throw new Error(tr("同步回执已更新，请重新展开查看新增。"));
    state.newFilesByPerson.set(personId, {
      jobId: job.id,
      loadedFor,
      loading: false,
      available: Boolean(receipt.available),
      files: Array.isArray(receipt.files) ? receipt.files : [],
      error: "",
    });
  } catch (error) {
    if (!isCurrent()) return;
    state.newFilesByPerson.set(personId, {
      jobId: job.id,
      loadedFor,
      loading: false,
      available: false,
      files: [],
      error: tm(error.message),
    });
  }
  updatePersonCard(personId);
  const currentJob = state.syncSummaries[personId];
  if (currentJob?.id === job.id && state.expandedNewFilePersonIds.has(personId)
    && newFilesVersion(currentJob) !== loadedFor) void loadNewFiles(personId);
}

function newFilesVersion(job) {
  return `${job.id}:${job.newFileCount ?? "legacy"}:${job.status}`;
}

function closeFileContextMenu({ restoreFocus = false } = {}) {
  const trigger = state.contextFile?.trigger;
  elements.fileContextMenu.hidden = true;
  state.contextFile = null;
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openFileContextMenu(target, clientX, clientY) {
  state.contextFile = {
    personId: target.dataset.personId,
    fileId: target.dataset.fileId,
    mediaId: target.dataset.mediaId || "",
    filename: target.textContent,
    trigger: target,
  };
  // A native modal makes siblings inert. Keep its menu inside the active dialog.
  (target.closest("dialog") || document.body).append(elements.fileContextMenu);
  elements.viewFileSourcesButton.disabled = !state.contextFile.mediaId;
  elements.fileContextMenu.hidden = false;
  elements.fileContextMenu.style.left = "0px";
  elements.fileContextMenu.style.top = "0px";
  const bounds = elements.fileContextMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8));
  const top = Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8));
  elements.fileContextMenu.style.left = `${left}px`;
  elements.fileContextMenu.style.top = `${top}px`;
  elements.revealFileLocationButton.focus();
}

async function runNewFileAction(action, personId, fileId) {
  const result = await api(`/api/persons/${personId}/${action}-new-file`, {
    method: "POST",
    body: JSON.stringify({ fileId }),
  });
  reportFileAction(action, result);
}

function mediaApiPath(personId, mediaId) {
  return `/api/persons/${encodeURIComponent(personId)}/media/${encodeURIComponent(mediaId)}`;
}

async function runMediaFileAction(action, personId, mediaId) {
  const result = await api(`${mediaApiPath(personId, mediaId)}/${action}`, { method: "POST" });
  reportFileAction(action, result);
}

function reportFileAction(action, result) {
  if (elements.mediaDialog.open) elements.mediaListStatus.classList.remove("is-error");
  if (action === "open") {
    const message = result.foreground
      ? tr("已使用系统默认程序打开并显示在前台。")
      : result.reason === "user-switched"
        ? tr("文件已打开；你已切换窗口，未打断当前操作。")
        : tr("文件已交给系统默认程序打开；暂未确认前台显示，请查看任务栏。");
    showToast(message);
    if (elements.mediaDialog.open) elements.mediaListStatus.textContent = message;
    return;
  }
  if (result.foreground) {
    showToast(tr("已在 Windows 文件资源管理器中定位该文件。"));
  } else {
    showToast(tr("文件资源管理器已打开；如果未显示在最前面，请查看任务栏。"));
  }
  if (elements.mediaDialog.open) elements.mediaListStatus.textContent = result.foreground
    ? tr("已在文件资源管理器中定位该文件。")
    : tr("文件资源管理器已打开；如果未显示在最前面，请查看任务栏。");
}

function renderMediaPage() {
  const view = state.mediaBrowser;
  if (!view) return;
  elements.mediaList.setAttribute("aria-busy", String(view.loading));
  elements.mediaList.inert = view.loading;
  elements.mediaPreviousPage.disabled = view.loading || view.offset <= 0;
  elements.mediaNextPage.disabled = view.loading || view.offset + view.limit >= view.total;
  elements.refreshMediaList.disabled = view.loading;
  const first = view.total ? view.offset + 1 : 0;
  const last = Math.min(view.offset + view.items.length, view.total);
  elements.mediaPageStatus.textContent = tr`${first}–${last} / ${view.total} 个文件`;
  elements.mediaListStatus.classList.toggle("is-error", Boolean(view.error));
  elements.mediaListStatus.textContent = view.error || (view.loading ? tr("正在读取本地媒体索引…") : tr("单击文件名用系统程序打开；右键可打开文件位置或查看来源。"));
  if (view.loading && !view.items.length) {
    setInterfaceHtml(elements.mediaList, tr('<div class="media-list-empty">正在读取…</div>'));
  } else if (!view.items.length) {
    setInterfaceHtml(elements.mediaList, `<div class="media-list-empty">${view.error ? tr("读取失败，请点击刷新重试。") : view.query ? tr("没有匹配的文件，请更换搜索内容。") : tr("还没有已保存媒体。完成首次同步后，可在这里查看文件和全部发布来源。")}</div>`);
  } else {
    setInterfaceHtml(elements.mediaList, `<ol class="media-library-list">${view.items.map((file) => tr`
      <li class="media-library-row">
        <span class="new-file-kind is-${escapeHtml(file.kind)}">${newFileKindLabel(file.kind)}</span>
        <div class="media-file-copy">
          <button class="media-file-name" type="button" aria-haspopup="menu" data-person-id="${escapeHtml(view.personId)}" data-media-id="${escapeHtml(file.mediaId)}" title="${escapeHtml(file.filename)} · 单击使用系统程序打开">${escapeHtml(file.filename)}</button>
          <span>${escapeHtml(file.relativePath)} · ${formatBytes(file.bytes)}</span>
        </div>
        <button class="file-sources-button" type="button" data-person-id="${escapeHtml(view.personId)}" data-media-id="${escapeHtml(file.mediaId)}" data-filename="${escapeHtml(file.filename)}">查看来源 <b>${Number(file.sourceCount) || 0}</b></button>
      </li>`).join("")}</ol>`);
  }
}

async function loadMediaPage({ query, offset } = {}) {
  const view = state.mediaBrowser;
  if (!view) return;
  window.clearTimeout(view.searchTimer);
  if (query !== undefined) view.query = String(query).trim().slice(0, 200);
  if (offset !== undefined) view.offset = Math.max(0, Number(offset) || 0);
  const sequence = ++view.sequence;
  view.loading = true;
  view.error = "";
  closeFileContextMenu();
  renderMediaPage();
  const params = new URLSearchParams({ query: view.query, offset: String(view.offset), limit: String(view.limit) });
  const isCurrent = () => state.mediaBrowser === view && view.sequence === sequence && elements.mediaDialog.open;
  try {
    const result = await api(`/api/persons/${encodeURIComponent(view.personId)}/media?${params}`);
    if (!isCurrent()) return;
    view.items = Array.isArray(result.items) ? result.items : [];
    view.total = Math.max(0, Number(result.total) || 0);
    view.offset = Math.max(0, Number(result.offset) || 0);
    view.limit = Math.max(1, Number(result.limit) || 50);
    // A deletion or refreshed index can remove the last page.
    if (view.total && view.offset >= view.total) {
      return await loadMediaPage({ offset: Math.floor((view.total - 1) / view.limit) * view.limit });
    }
  } catch (error) {
    if (!isCurrent()) return;
    view.error = tm(error.message);
    view.items = [];
  }
  if (!isCurrent()) return;
  view.loading = false;
  renderMediaPage();
}

function openMediaDialog(person, trigger) {
  closeFileContextMenu();
  state.mediaBrowser = { personId: person.id, query: "", offset: 0, limit: 50, total: 0, items: [], sequence: 0, loading: false, error: "", trigger };
  elements.mediaDialogTitle.textContent = tr`${person.name} · 媒体与来源`;
  elements.mediaPersonPath.textContent = person.folderPath;
  elements.mediaSearch.value = "";
  elements.mediaDialog.showModal();
  elements.mediaSearch.focus();
  void loadMediaPage();
}

function closeMediaDialog() {
  const view = state.mediaBrowser;
  window.clearTimeout(view?.searchTimer);
  closeFileContextMenu();
  if (elements.sourcesDialog.open) closeSourcesDialog();
  state.mediaBrowser = null;
  elements.mediaDialog.close();
  if (view?.trigger?.isConnected) view.trigger.focus();
}

function formatSourceDate(value) {
  if (!value || typeof value === "boolean") return tr("未知");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? tr("未知") : date.toLocaleString(uiLocale(), { timeZone: "Asia/Shanghai" });
}

function sourcePublicationDate(source) {
  return /^\d{8}$/.test(source.publicationDate || "") ? source.publicationDate : tr("日期未知");
}

function sourceDateBasis(source) {
  if (source.dateBasis === "created-at-beijing") return tr("平台发布时间（北京时间）");
  if (source.dateBasis === "first-collected-beijing") return tr("首次采集日期（无发布时间，北京时间）");
  if (source.dateBasis === "created-at-utc") return tr("平台发布时间（UTC，历史记录）");
  if (source.dateBasis === "first-collected-utc") return tr("首次采集日期（无发布时间，UTC，历史记录）");
  if (source.dateBasis === "legacy-filename") return tr("旧备份文件名日期（UTC，完整发布时间未知）");
  if (source.dateBasis === "platform" && sourcePublicationDate(source) !== tr("日期未知")) return tr("平台明确显示");
  if (source.dateBasis === "session-timezone" && source.displayTimeZone) return tr`平台会话 · ${source.displayTimeZone}`;
  return tr("尚未获得可靠的显示日期");
}

function backupSourceDetails(source) {
  const imports = Array.isArray(source.backupImports) ? source.backupImports.filter((item) => item && typeof item.originalFileName === "string" && typeof item.backupPath === "string") : [];
  if (!imports.length) return "";
  return tr`<div class="media-source-backups"><p>备份记录 · 原文件保留不变</p><ul>${imports.map((item) => tr`<li><span class="backup-original-name">${escapeHtml(item.originalFileName)}</span><span class="backup-source-path">${escapeHtml(item.backupPath)}</span><span>首次导入（北京时间） · ${escapeHtml(formatSourceDate(item.importedAt))}</span>${item.attributionEvidence === "local-modified" ? tr`<span class="backup-variant-note">本地修改副本 · 单独保留，不与原图合并；发布日期和原帖信息取自已核验原图。</span><span class="backup-source-path">原图资产 · ${escapeHtml(item.derivedFromMediaId || tr("未知"))}</span><span class="backup-source-path">副本资产 · ${escapeHtml(item.observedSha256 || tr("未知"))}</span><span>${escapeHtml(item.reviewEvidence?.details || tr("已核验备份与原图为不同字节版本。"))}</span>` : ""}</li>`).join("")}</ul></div>`;
}

function isLocalBackupVariant(source) {
  return Array.isArray(source.backupImports) && source.backupImports.some((item) => item?.attributionEvidence === "local-modified");
}

function formatPublishedTime(source) {
  if (!source.createdAt || typeof source.createdAt !== "string") return tr("未知");
  const date = new Date(source.createdAt);
  if (Number.isNaN(date.getTime())) return tr("未知");
  if (source.displayTimeZone) {
    try {
      return new Intl.DateTimeFormat(uiLocale(), { timeZone: source.displayTimeZone, dateStyle: "short", timeStyle: "medium" }).format(date);
    } catch {}
  }
  return date.toISOString();
}

function safeSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

function localSourceKey(source) {
  if (typeof source?.sourceKey === "string" && source.sourceKey) return source.sourceKey;
  return [source?.platformId, source?.accountId, source?.logicalKey].every((item) => typeof item === "string" && item)
    ? JSON.stringify([source.platformId, source.accountId, source.logicalKey]) : "";
}

async function openBoundPost(button) {
  if (button.disabled || button.dataset.actionPending === "true") return;
  const { personId, platformId, accountId, postId, mediaId, sourceKey } = button.dataset;
  const reference = mediaId && sourceKey ? { mediaId, sourceKey }
    : platformId && accountId && postId ? { platformId, accountId, postId } : null;
  if (!personId || !reference) { showToast(tr("未找到此原帖的本地账号记录，未打开未登录窗口。"), true); return; }
  const label = button.textContent;
  button.disabled = true;
  button.dataset.actionPending = "true";
  button.setAttribute("aria-busy", "true");
  button.textContent = tr("正在打开…");
  try {
    const result = await api(`/api/persons/${encodeURIComponent(personId)}/open-post`, { method: "POST", body: JSON.stringify(reference) });
    if (!appPageClosed) showToast(tm(result.message) || tr("已在对应账号的独立登录窗口打开原帖。"));
  } catch (error) {
    if (!appPageClosed) showToast(error.status === 409 ? tr`${tm(error.message)}；请等待后再点“查看原帖”。` : error.status === 404
      ? tr("此原帖记录或后台接口不可用，未打开未登录页面；请重新启动新版后重试。") : tm(error.message), true);
  } finally {
    delete button.dataset.actionPending;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = label;
  }
}

async function loadFileSources() {
  const view = state.sourceBrowser;
  if (!view) return;
  const sequence = ++view.sequence;
  const isCurrent = () => state.sourceBrowser === view && view.sequence === sequence && elements.sourcesDialog.open;
  elements.sourcesList.setAttribute("aria-busy", "true");
  elements.sourcesStatus.classList.remove("is-error");
  elements.sourcesStatus.textContent = tr("正在读取本地来源记录…");
  elements.sourcesList.replaceChildren();
  try {
    const result = await api(`${mediaApiPath(view.personId, view.mediaId)}/sources`);
    if (!isCurrent()) return;
    view.sources = Array.isArray(result.sources) ? result.sources : [];
    renderFileSources(view);
  } catch (error) {
    if (!isCurrent()) return;
    elements.sourcesStatus.classList.add("is-error");
    elements.sourcesStatus.textContent = tm(error.message);
    setInterfaceHtml(elements.sourcesList, tr('<button class="secondary-button retry-file-sources" type="button">重试读取来源</button>'));
  }
  if (isCurrent()) elements.sourcesList.setAttribute("aria-busy", "false");
}

function renderFileSources(view) {
    const sources = view.sources;
    const person = state.persons.find((item) => item.id === view.personId);
    elements.sourcesStatus.textContent = tr`共 ${sources.length} 条来源记录 · 采集账号移除后，历史来源仍会保留。`;
    setInterfaceHtml(elements.sourcesList, sources.length ? `<ol class="media-source-list">${sources.map((source) => {
      const url = safeSourceUrl(source.postUrl);
      const accountExists = person?.platforms.some((platform) => platform.id === source.platformId && platform.accounts.some((account) => account.id === source.accountId));
      const localVariant = isLocalBackupVariant(source);
      const sourceKey = localSourceKey(source);
      return tr`<li class="media-source-record">
        <div class="media-source-heading"><strong>${escapeHtml(source.platformLabel || source.platformId || tr("未知平台"))} · ${escapeHtml(source.accountLabel || source.accountId || tr("未知账号"))}</strong>${accountExists ? "" : tr('<span class="source-history-chip">历史账号</span>')}${Array.isArray(source.backupImports) && source.backupImports.length ? tr('<span class="source-history-chip">含备份记录</span>') : ""}${localVariant ? tr('<span class="source-history-chip">本地修改副本</span>') : ""}${url && sourceKey ? tr`<button class="open-bound-post" type="button" data-person-id="${escapeHtml(view.personId)}" data-media-id="${escapeHtml(view.mediaId)}" data-source-key="${escapeHtml(sourceKey)}" title="使用当前对应平台的独立登录资料打开；若账号映射已移除将明确提示">${localVariant ? tr("查看原图原帖") : tr("打开原帖")} ↗</button>` : tr('<span class="source-link-unavailable">原帖链接未知</span>')}</div>
        <dl><div><dt>${localVariant ? tr("原图发布日期") : ["first-collected-utc", "first-collected-beijing"].includes(source.dateBasis) ? tr("命名日期（首次采集）") : tr("发布日期")}</dt><dd>${escapeHtml(sourcePublicationDate(source))}</dd></div><div><dt>日期依据</dt><dd>${escapeHtml(sourceDateBasis(source))}</dd></div><div><dt>${localVariant ? tr("原图发布时间") : tr("发布时间")}${source.displayTimeZone ? "" : tr("（原始时间）")}</dt><dd>${escapeHtml(formatPublishedTime(source))}</dd></div><div><dt>首次采集（北京时间）</dt><dd>${escapeHtml(formatSourceDate(source.firstSeenAt))}</dd></div><div><dt>帖子 / 媒体标识</dt><dd>${escapeHtml(source.postId || source.logicalKey || tr("未知"))}</dd></div></dl>
        ${backupSourceDetails(source)}
      </li>`;
    }).join("")}</ol>` : tr('<div class="media-list-empty">此文件还没有发布来源记录。</div>'));
}

function openSourcesDialog({ personId, mediaId, filename, trigger }) {
  if (!mediaId) return;
  closeFileContextMenu();
  state.sourceBrowser = { personId, mediaId, filename, trigger, sequence: 0 };
  elements.sourcesFileName.textContent = filename || mediaId;
  if (!elements.sourcesDialog.open) elements.sourcesDialog.showModal();
  elements.closeSourcesDialog.focus();
  void loadFileSources();
}

function closeSourcesDialog() {
  const view = state.sourceBrowser;
  state.sourceBrowser = null;
  elements.sourcesDialog.close();
  if (view?.trigger?.isConnected) view.trigger.focus();
}

function ensureSyncPolling(job) {
  if (!job || !["queued", "running"].includes(job.status) || syncPollTimers.has(job.id)) return;
  let failures = 0;
  const poll = async () => {
    try {
      const latest = await api(`/api/sync-jobs/${job.id}`);
      failures = 0;
      if (!acceptSyncSummary(latest, job.id)) {
        syncPollTimers.delete(job.id);
        return;
      }
      updatePersonCard(latest.personId);
      renderSyncAllControl();
      const cached = state.newFilesByPerson.get(latest.personId);
      if (state.expandedNewFilePersonIds.has(latest.personId) && !cached?.loading
        && cached?.loadedFor !== newFilesVersion(latest)) void loadNewFiles(latest.personId);
      if (["queued", "running"].includes(latest.status)) {
        syncPollTimers.set(job.id, window.setTimeout(poll, 1_000));
      } else {
        syncPollTimers.delete(job.id);
        showToast(tm(latest.message), latest.status === "failed" || syncIssues(latest).failed > 0);
      }
    } catch (error) {
      const current = state.syncSummaries[job.personId];
      if (current?.id !== job.id || !["queued", "running"].includes(current.status)) {
        syncPollTimers.delete(job.id);
        return;
      }
      failures += 1;
      if (failures === 1) showToast(tr`${tm(error.message)}；稍后自动重试读取进度。`, true);
      if (error.status === 404) await refreshState().catch(() => {});
      if (state.syncSummaries[job.personId]?.id === job.id
        && ["queued", "running"].includes(state.syncSummaries[job.personId]?.status)) {
        syncPollTimers.set(job.id, window.setTimeout(poll, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))));
      } else syncPollTimers.delete(job.id);
    }
  };
  syncPollTimers.set(job.id, window.setTimeout(poll, 600));
}

function renderSyncAllControl() {
  const jobs = state.persons.map((person) => state.syncSummaries[person.id]).filter(Boolean);
  const runningCount = jobs.filter((job) => job.status === "running").length;
  const queuedCount = jobs.filter((job) => job.status === "queued").length;
  const activeCount = runningCount + queuedCount;
  const completedCount = jobs.filter((job) => job.status === "completed").length;
  const issueCount = jobs.filter((job) =>
    ["failed", "cancelled"].includes(job.status) || syncIssues(job).failed > 0).length;

  elements.syncAllButton.disabled = state.syncAllLaunching || activeCount > 0 || dedupBusy() || state.persons.length === 0 || state.deletingPersonIds.size > 0;
  elements.syncAllButton.classList.toggle("is-active", state.syncAllLaunching || activeCount > 0);
  elements.syncAllButton.setAttribute("aria-busy", String(state.syncAllLaunching || activeCount > 0));
  const syncAllLabel = state.syncAllLaunching ? tr("正在建立队列…") : activeCount ? tr("同步队列运行中") : tr("一键同步全部");
  const syncAllText = elements.syncAllButton.lastElementChild;
  if (syncAllText.textContent !== syncAllLabel) syncAllText.textContent = syncAllLabel;

  if (state.persons.length === 0) {
    elements.syncAllStatus.textContent = tr("新建人物后即可同步全部账号。");
  } else if (state.syncAllLaunching) {
    elements.syncAllStatus.textContent = tr`正在为 ${state.persons.length} 个人物建立并行任务…`;
  } else if (activeCount) {
    const parts = [];
    if (runningCount) parts.push(tr`${runningCount} 个正在同步`);
    if (queuedCount) parts.push(tr`${queuedCount} 个排队等待`);
    elements.syncAllStatus.textContent = tr`${parts.join(" · ")} · 账号级并行 · 共用登录会话自动排队`;
  } else if (jobs.length === 0) {
    elements.syncAllStatus.textContent = tr`${state.persons.length} 个人物等待首次同步 · 账号级并行 · 共用登录会话自动排队。`;
  } else {
    const untouchedCount = Math.max(0, state.persons.length - jobs.length);
    const parts = [tr`${completedCount} 个已有同步记录`];
    if (untouchedCount) parts.push(tr`${untouchedCount} 个等待首次同步`);
    if (issueCount) parts.push(tr`${issueCount} 个失败或中断`);
    elements.syncAllStatus.textContent = parts.join(" · ");
  }
  renderDedupControl();
}

function dedupBusy() {
  return state.deduplication.launching || state.deduplication.job?.status === "running";
}

function anySyncActive() {
  return state.syncAllLaunching || Object.values(state.syncSummaries).some((job) => ["queued", "running"].includes(job?.status));
}

function personDedupActive(personId) {
  const job = state.deduplication.job;
  return job?.status === "running" && (job.scope === "person" && job.personId === personId
    || job.scope === "all" && job.currentPersonId === personId);
}

function safeDedupCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function renderDedupControl() {
  const view = state.deduplication;
  const job = view.job;
  const running = job?.status === "running";
  const reportHasErrors = (Array.isArray(job?.errors) && job.errors.length > 0)
    || (Array.isArray(job?.results) && job.results.some((result) => Array.isArray(result?.errors) && result.errors.length > 0));
  const syncing = anySyncActive();
  const unavailable = dedupFeatureUnavailable();
  // Missing optional tools stay discoverable by pointer and keyboard. The
  // feature guard offers preparation; it never starts a dedup job implicitly.
  const disabled = !unavailable && (dedupBusy() || syncing || !state.persons.length || state.deletingPersonIds.size > 0);
  if (elements.dedupAllButton.disabled !== disabled) elements.dedupAllButton.disabled = disabled;
  if (elements.dedupAllButton.classList.contains("dedup-unavailable") !== unavailable) elements.dedupAllButton.classList.toggle("dedup-unavailable", unavailable);
  const ariaDisabled = String(unavailable);
  if (elements.dedupAllButton.getAttribute("aria-disabled") !== ariaDisabled) elements.dedupAllButton.setAttribute("aria-disabled", ariaDisabled);
  const ariaBusy = String(dedupBusy() || featureOfferPending || featureInstallSubmitting || state.features.dedup?.installing === true);
  if (elements.dedupAllButton.getAttribute("aria-busy") !== ariaBusy) elements.dedupAllButton.setAttribute("aria-busy", ariaBusy);
  const title = unavailable ? tr("相似去重工具包尚未准备；点击可确认下载。媒体采集和精确去重仍可使用。") : "";
  if (elements.dedupAllButton.title !== title) elements.dedupAllButton.title = title;
  const label = view.launching ? tr("正在开始去重…") : running ? tr("本地去重进行中") : tr("一键去重");
  if (elements.dedupAllButton.lastElementChild.textContent !== label) elements.dedupAllButton.lastElementChild.textContent = label;
  elements.dedupReceipt.hidden = (!job || job.status === "idle" || (job.dismissed && !running)) && !view.error;
  elements.dedupReceipt.dataset.status = job?.status || "idle";
  elements.dedupReceipt.classList.toggle("has-errors", Boolean(reportHasErrors));
  elements.dedupJobStatus.textContent = job?.status === "completed" && reportHasErrors ? tr("完成但有失败")
    : ({ idle: tr("等待开始"), running: tr("正在整理"), completed: tr("整理完成"), cancelled: tr("已停止"), failed: tr("需要重试") })[job?.status] || tr("尚未开始");
  elements.dedupStatus.classList.toggle("is-error", Boolean(view.error) || job?.status === "failed" || Boolean(reportHasErrors));
  const progressLabel = [job?.personName, tm(job?.message)].filter((item) => typeof item === "string" && item).join(" · ");
  elements.dedupStatus.textContent = tm(view.error) || progressLabel || tr("完全在本地比对，无法确认的文件会保留。");
  const scanned = safeDedupCount(job?.scanned), total = safeDedupCount(job?.total);
  elements.dedupProgress.value = total ? Math.min(100, Math.round(scanned / total * 100)) : job?.status === "completed" ? 100 : 0;
  elements.dedupProgress.hidden = !job;
  elements.dedupScanned.textContent = `${scanned} / ${total}`;
  elements.dedupMerged.textContent = String(safeDedupCount(job?.merged));
  elements.dedupReview.textContent = String(safeDedupCount(job?.review));
  elements.dedupArchived.textContent = formatBytes(safeDedupCount(job?.archivedBytes));
  elements.dedupCancelButton.hidden = !running;
  elements.dedupCancelButton.disabled = view.cancelling || Boolean(job?.cancelRequested);
  elements.dedupCancelButton.textContent = view.cancelling || job?.cancelRequested ? tr("正在安全停止并关闭…") : tr("停止并关闭");
  const terminal = Boolean(job && ["completed", "cancelled", "failed"].includes(job.status));
  elements.dedupCloseButton.hidden = !terminal;
  elements.dedupCloseButton.disabled = view.closing;
  elements.dedupCloseButton.textContent = view.closing ? tr("正在关闭…") : tr("关闭结果");
  elements.dedupContinueButton.hidden = !terminal || !["cancelled", "failed"].includes(job.status);
  elements.dedupContinueButton.disabled = dedupBusy() || syncing || view.closing || state.deletingPersonIds.size > 0;
  // An open result list belongs to the reader until it is collapsed. Polling
  // updates the compact receipt, not file buttons, menus, media dialogs or text
  // currently being read in the expanded details.
  if (languageRefreshing || !elements.dedupDetails.open) renderDedupResults();
  refreshDedupConflictControls();
}

function renderDedupResults() {
  const job = state.deduplication.job;
  const results = (Array.isArray(job?.results) ? job.results : []).slice(0, 100);
  const errors = (Array.isArray(job?.errors) ? job.errors : []).slice(0, 100);
  setInterfaceHtml(elements.dedupResultList, results.map((item) => tr`<li>${escapeHtml(item?.personName || tr("人物"))} · 已合并 ${safeDedupCount(item?.merged)} · 疑似项保留 ${safeDedupCount(item?.review)}${typeof item?.message === "string" ? ` · ${escapeHtml(tm(item.message))}` : ""}${Array.isArray(item?.reviewItems) && item.reviewItems.length ? `<ul>${renderDedupReviewItems(item.reviewItems, item.personId || (job?.scope === "person" ? job.personId : ""))}</ul>` : ""}${Array.isArray(item?.errors) && item.errors.length ? `<ul>${item.errors.slice(0, 50).map((error) => `<li class="is-error">${escapeHtml([error?.filename, tm(error?.message)].filter((value) => typeof value === "string" && value).join(" · "))}</li>`).join("")}</ul>` : ""}</li>`).join("")
    + errors.map((item) => `<li class="is-error">${escapeHtml(typeof item === "string" ? tm(item) : [item?.personName, tm(item?.message)].filter((value) => typeof value === "string" && value).join(" · ") || tr("本地处理失败，请重试。"))}</li>`).join(""));
}

function renderDedupReviewItems(items, personId = "") {
  if (!Array.isArray(items)) return "";
  return items.slice(0, 50).map((item) => {
    const filenames = Array.isArray(item?.filenames) ? item.filenames.slice(0, 4) : [];
    const ids = Array.isArray(item?.mediaIds) ? item.mediaIds : [];
    const files = filenames.map((filename, position) => {
      if (typeof filename !== "string") return "";
      const mediaId = ids[position];
      return personId && typeof mediaId === "string" && mediaId
        ? tr`<button class="dedup-file-name" type="button" aria-haspopup="menu" data-person-id="${escapeHtml(personId)}" data-media-id="${escapeHtml(mediaId)}" data-render-key="${escapeHtml(mediaId)}" title="单击使用系统关联程序打开；右键可定位文件或查看来源">${escapeHtml(filename)}</button>`
        : escapeHtml(filename);
    }).filter(Boolean);
    return `<li class="dedup-review-item">${files.join(" ↔ ") || tr("待确认文件")} · ${escapeHtml(typeof item?.reason === "string" ? tm(item.reason) : tr("证据不足，已保留各版本。"))}</li>`;
  }).join("");
}

function refreshDedupConflictControls() {
  const busy = dedupBusy();
  const syncing = anySyncActive();
  if (elements.createPersonButton.disabled !== busy) elements.createPersonButton.disabled = busy;
  for (const person of state.persons) {
    const card = [...elements.peopleList.children].find((node) => node.dataset.personId === person.id);
    if (!card) continue;
    const deleting = state.deletingPersonIds.has(person.id);
    const syncActive = ["queued", "running"].includes(state.syncSummaries[person.id]?.status);
    card.querySelectorAll(".sync-person, .edit-person, .delete-person, .recheck-person").forEach((button) => {
      const disabled = busy || deleting || button.dataset.actionPending === "true" || (button.matches(".delete-person, .recheck-person") && syncActive);
      if (button.disabled !== disabled) button.disabled = disabled;
    });
    const dedupButton = card.querySelector(".dedup-person");
    if (dedupButton) {
      const active = personDedupActive(person.id);
      const stopping = state.deduplication.cancelling || Boolean(state.deduplication.job?.cancelRequested);
      const unavailable = dedupFeatureUnavailable();
      const disabled = unavailable ? false : active ? stopping : busy || syncing || deleting || state.deletingPersonIds.size > 0;
      if (dedupButton.disabled !== disabled) dedupButton.disabled = disabled;
      if (dedupButton.classList.contains("dedup-unavailable") !== unavailable) dedupButton.classList.toggle("dedup-unavailable", unavailable);
      const ariaDisabled = String(unavailable);
      if (dedupButton.getAttribute("aria-disabled") !== ariaDisabled) dedupButton.setAttribute("aria-disabled", ariaDisabled);
      if (dedupButton.classList.contains("danger-button") !== active) dedupButton.classList.toggle("danger-button", active);
      if (dedupButton.classList.contains("secondary-button") === active) dedupButton.classList.toggle("secondary-button", !active);
      const ariaBusy = String(active || (state.deduplication.launching && state.deduplication.launchingPersonId === person.id));
      if (dedupButton.getAttribute("aria-busy") !== ariaBusy) dedupButton.setAttribute("aria-busy", ariaBusy);
      const label = active ? stopping ? tr("正在安全停止…") : state.deduplication.job.scope === "all" ? tr("停止全部并关闭") : tr("停止并关闭")
        : state.deduplication.launching && state.deduplication.launchingPersonId === person.id ? tr("正在开始去重…") : tr("资料去重");
      if (dedupButton.textContent !== label) dedupButton.textContent = label;
    }
  }
}

function acceptDedupStatus(payload, expectedVersion) {
  if (expectedVersion !== undefined && expectedVersion !== dedupStatusVersion) return false;
  const job = payload?.job || payload;
  if (!job || !["idle", "running", "completed", "cancelled", "failed"].includes(job.status)) return false;
  const previous = state.deduplication.job;
  if (previous && previous.id === job.id && ["completed", "cancelled", "failed"].includes(previous.status) && job.status === "running") return false;
  const terminal = ["completed", "cancelled", "failed"].includes(job.status);
  if (job.dismissed || (terminal && closeAfterStoppingDedupIds.has(job.id))) dismissedDedupIds.add(job.id);
  state.deduplication.job = dismissedDedupIds.has(job.id) && terminal ? { ...job, dismissed: true } : job;
  state.deduplication.error = "";
  dedupStatusVersion += 1;
  renderSyncAllControl();
  refreshDedupConflictControls();
  return true;
}

function ensureDedupPolling(delay = 1_000) {
  window.clearTimeout(dedupPollTimer);
  if (appPageClosed || state.deduplication.job?.status !== "running") return;
  dedupPollTimer = window.setTimeout(() => void pollDedupStatus(), delay);
}

async function pollDedupStatus() {
  if (appPageClosed || dedupPollInFlight) return;
  dedupPollInFlight = true;
  const version = dedupStatusVersion;
  try {
    const latest = await api("/api/dedup-status");
    if (appPageClosed) return;
    acceptDedupStatus(latest, version);
  } catch (error) {
    if (!appPageClosed && version === dedupStatusVersion) {
      state.deduplication.error = tr`${tm(error.message)}；进度读取会自动重试，已保存内容不受影响。`;
      renderDedupControl();
    }
  } finally {
    dedupPollInFlight = false;
    ensureDedupPolling(state.deduplication.error ? 5_000 : 1_000);
  }
}

async function startDeduplication(personId = null) {
  const person = personId ? state.persons.find((item) => item.id === personId) : null;
  if (dedupFeatureUnavailable()) {
    if (personId && !person) return;
    await offerDedupFeature();
    return;
  }
  if (dedupBusy() || anySyncActive() || state.deletingPersonIds.size > 0 || !state.persons.length
    || (personId && !person) || (!personId && elements.dedupAllButton.disabled)) return;
  state.deduplication.launching = true;
  state.deduplication.launchingPersonId = personId;
  renderSyncAllControl();
  refreshDedupConflictControls();
  try {
    if (!await ensureDedupTools() || appPageClosed) return;
    const confirmed = await requestConfirmation({ title: person ? tr`仅对“${person.name}”进行本地去重？` : tr("对全部人物进行本地去重？"), tone: "neutral", confirmLabel: tr("开始本地去重"),
      message: tr`${person ? tr`只检查“${person.name}”已经保存的图片与完整视频，不处理其他人物。` : tr("在每个人物内比对图片与完整视频。")}按可测量的分辨率、清晰度与内容完整性选保留版本，不保证适合 LoRA 训练。保留不同音轨版本；判断不充分的文件保留，这不是下载失败。可随时停止去重；安全停止后关闭本次结果，再次开始会复用已保存的本地检查记录。合并版本移入人物 Index/DedupArchive，全部发布来源和恢复记录保留；归档仍占空间，不会自动永久删除。不上传媒体、不使用 AI 服务，也不清理账号登录资料。` });
    if (!confirmed || appPageClosed) return;
    const result = await api(person ? "/api/dedup-person" : "/api/dedup-all", { method: "POST", body: JSON.stringify(person ? { confirm: true, personId: person.id } : { confirm: true }) });
    if (appPageClosed) return;
    acceptDedupStatus(result);
    ensureDedupPolling();
  } catch (error) {
    state.deduplication.error = error.status === 404 ? tr("后台服务尚未提供本地去重，请关闭工具后重新启动新版。") : tm(error.message);
    renderDedupControl();
    showToast(state.deduplication.error, true);
  } finally {
    state.deduplication.launching = false;
    state.deduplication.launchingPersonId = null;
    renderSyncAllControl();
    refreshDedupConflictControls();
  }
}

async function cancelDeduplication() {
  const view = state.deduplication;
  const id = view.job?.id;
  if (view.job?.status !== "running" || view.cancelling || view.job.cancelRequested) return;
  view.cancelling = true;
  closeAfterStoppingDedupIds.add(id);
  renderDedupControl();
  try {
    const latest = await api("/api/dedup-cancel", { method: "POST", body: JSON.stringify({ confirm: true, closeResults: true }) });
    if (appPageClosed || state.deduplication.job?.id !== id) return;
    acceptDedupStatus(latest);
    ensureDedupPolling();
  } catch (error) {
    closeAfterStoppingDedupIds.delete(id);
    if (!appPageClosed && state.deduplication.job?.id === id) { view.error = tm(error.message); renderDedupControl(); }
  } finally {
    view.cancelling = false;
    if (!appPageClosed) renderDedupControl();
  }
}

async function closeDedupResults() {
  const view = state.deduplication;
  const id = view.job?.id;
  if (!id || !["completed", "cancelled", "failed"].includes(view.job.status) || view.closing) return;
  view.closing = true;
  renderDedupControl();
  try {
    const latest = await api("/api/dedup-close", { method: "POST", body: JSON.stringify({ confirm: true, jobId: id }) });
    if (appPageClosed || view.job?.id !== id) return;
    dismissedDedupIds.add(id);
    acceptDedupStatus(latest);
    elements.dedupDetails.open = false;
    showToast(tr("去重结果已关闭，媒体、来源及检查记录保留。"));
  } catch (error) {
    if (!appPageClosed && view.job?.id === id) { view.error = error.status === 404 ? tr("后台未提供关闭结果接口，请重新启动新版；媒体与检查记录保留。") : tm(error.message); renderDedupControl(); }
  } finally {
    view.closing = false;
    if (!appPageClosed) renderDedupControl();
  }
}

function renderPeople() {
  const accountCount = state.persons.reduce(
    (sum, person) => sum + person.platforms.reduce((inner, platform) => inner + platform.accounts.length, 0),
    0,
  );
  const homepageCount = state.persons.filter((person) => person.homepageUrl).length;
  const queuedFollowCount = state.persons.reduce(
    (sum, person) => sum + person.platforms.reduce(
      (inner, platform) => inner + platform.accounts.filter((account) => account.followRequested).length,
      0,
    ),
    0,
  );
  setInterfaceHtml(elements.peopleSummary, tr`
    <span class="summary-pill">${state.persons.length} 个人物</span>
    <span class="summary-pill">${accountCount} 个被追踪账号</span>
    <span class="summary-pill">${homepageCount} 个主页来源</span>
    <span class="summary-pill">${queuedFollowCount} 个待关注</span>
    <span class="summary-pill">敏感媒体默认包含</span>
  `);
  renderSyncAllControl();

  if (state.persons.length === 0) {
    setInterfaceHtml(elements.peopleList, tr`
      <div class="empty-state">
        <div>
          <div class="empty-state-mark" aria-hidden="true"></div>
          <h2>还没有采集账号</h2>
          <p>先创建一个人物，再把他在 X、Instagram、Threads、Facebook 或 TikTok 上的多个账号放到对应平台下。</p>
        </div>
      </div>`);
    return;
  }

  const existing = new Map([...elements.peopleList.querySelectorAll(":scope > .person-card")]
    .map((card) => [card.dataset.personId, card]));
  elements.peopleList.querySelector(":scope > .empty-state")?.remove();
  state.persons.forEach((person, index) => {
    let card = existing.get(person.id);
    if (!card) card = elementFromHtml(renderPersonCard(person));
    else if (pressedPersonId === person.id) deferredPersonUpdates.add(person.id);
    else reconcileElement(card, elementFromHtml(renderPersonCard(person)));
    const position = elements.peopleList.children[index];
    if (position !== card) elements.peopleList.insertBefore(card, position || null);
    existing.delete(person.id);
  });
  for (const card of existing.values()) card.remove();
  Object.values(state.syncSummaries).forEach(ensureSyncPolling);
}

function updatePersonCard(personId) {
  if (pressedPersonId === personId) {
    deferredPersonUpdates.add(personId);
    return;
  }
  const person = state.persons.find((item) => item.id === personId);
  const card = [...elements.peopleList.children].find((item) => item.dataset.personId === personId);
  if (person && card) reconcileElement(card, elementFromHtml(renderPersonCard(person)));
}

function renderPersonCard(person) {
    const tags = person.platforms.map((platform) => {
      const paused = platform.accounts.filter((account) => account.syncEnabled === false).length;
      return `<span class="platform-tag">${escapeHtml(platform.label)} · ${platform.accounts.length}${paused ? tr`<span class="platform-paused-count">${paused} 个已暂停</span>` : ""}</span>`;
    }).join("");
    const homepage = person.homepageUrl
      ? tr`<a class="homepage-source" href="${escapeHtml(person.homepageUrl)}" target="_blank" rel="noreferrer">主页来源 · ${escapeHtml(new URL(person.homepageUrl).hostname)}</a>`
      : tr`<span class="homepage-source is-empty">未设置个人主页</span>`;
    const syncJob = state.syncSummaries[person.id];
    const syncActive = ["queued", "running"].includes(syncJob?.status);
    const deleting = state.deletingPersonIds.has(person.id);
    const dedupActive = personDedupActive(person.id);
    const dedupStopping = state.deduplication.cancelling || Boolean(state.deduplication.job?.cancelRequested);
    const dedupUnavailable = dedupFeatureUnavailable();
    const dedupDisabled = !dedupUnavailable && (dedupActive ? dedupStopping : deleting || dedupBusy() || anySyncActive() || state.deletingPersonIds.size > 0);
    return tr`
      <article class="person-card" data-person-id="${escapeHtml(person.id)}">
        <div class="person-card-head">
          <div><div class="person-name-row"><h3>${escapeHtml(person.name)}</h3><button class="secondary-button open-person-folder" type="button" data-person-id="${escapeHtml(person.id)}" data-render-key="folder:${escapeHtml(person.id)}" title="打开此人物的文件夹">查看文件</button></div><p class="note">${escapeHtml(person.note || tr("未填写备注"))}</p></div>
          <div class="person-card-actions">
            <button class="${syncActive ? "danger-button cancel-sync" : "primary-button sync-person"}" type="button" data-person-id="${person.id}" ${deleting || (!syncActive && dedupBusy()) ? "disabled" : ""} ${syncActive ? `data-job-id="${syncJob.id}"` : ""}>${syncActive ? tr("停止") : (syncJob ? tr("增量同步") : tr("同步媒体"))}</button>
            <button class="${dedupActive ? "danger-button" : "secondary-button"} dedup-person${dedupUnavailable ? " dedup-unavailable" : ""}" type="button" data-person-id="${escapeHtml(person.id)}" ${dedupDisabled ? "disabled" : ""} aria-disabled="${dedupUnavailable}" aria-busy="${dedupActive}" title="只对这个人物已保存的图片与视频本地去重；停止后关闭结果，检查记录保留">${dedupActive ? dedupStopping ? tr("正在安全停止…") : state.deduplication.job.scope === "all" ? tr("停止全部并关闭") : tr("停止并关闭") : tr("资料去重")}</button>
            <button class="text-button browse-person-media" type="button" data-person-id="${escapeHtml(person.id)}" ${deleting ? "disabled" : ""}>媒体与来源</button>
            <button class="edit-person" type="button" data-person-id="${person.id}" ${deleting || dedupBusy() ? "disabled" : ""}>修改</button>
            <button class="danger-button delete-person" type="button" data-person-id="${person.id}" ${syncActive || deleting || dedupBusy() ? "disabled" : ""} title="${syncActive || dedupBusy() ? tr("请等待同步或去重完成后删除") : tr("删除人物并选择是否保留内容")}">${deleting ? tr("删除中…") : tr("删除")}</button>
          </div>
        </div>
        <div class="folder-path">${escapeHtml(person.folderPath)}</div>
        <div class="person-source-line">${homepage}</div>
        <div class="platform-tags">${tags}</div>
        ${renderSyncReceipt(person)}
        ${renderNewFiles(person)}
      </article>`;
}

function renderLinkedAccounts() {
  if (state.linkedAccounts.length === 0) {
    setInterfaceHtml(elements.linkedAccountsList, tr`<div class="empty-state"><div><h2>尚未关联账号</h2><p>不登录也能尝试公开内容；若要覆盖 X 敏感媒体或关注后可见内容，请创建关联并完成登录验证。</p></div></div>`);
    return;
  }

  const statusLabels = {
    verified: tr("已验证登录"),
    failed: tr("验证未通过"),
    pending: tr("等待验证"),
    unverified: tr("尚未验证"),
    unconfigured: tr("验证待配置"),
    "needs-configuration": tr("验证待配置"),
  };
  setInterfaceHtml(elements.linkedAccountsList, state.linkedAccounts.map((account) => {
    const status = account.loginCode === "login-rule-required" ? "unconfigured"
      : Object.hasOwn(statusLabels, account.loginStatus) ? account.loginStatus : "unverified";
    const platform = state.platforms[account.platformId];
    return tr`
      <article class="linked-card">
        <div class="linked-card-copy">
          <div class="linked-title-line"><h3>${escapeHtml(account.label)}</h3><span class="login-chip is-${status}">${statusLabels[status] || tr("尚未验证")}</span></div>
          <p>${escapeHtml(account.platformLabel || platform?.label)} · ${escapeHtml(tm(account.browserLabel) || tm(state.runtime.label))}</p>
          <small>${escapeHtml(tm(account.loginMessage) || tr("尚未验证登录。"))}</small>
          ${account.platformId === "tiktok" ? tr('<small>登录完成后请关闭专用登录窗口，再验证或同步。后台工作不显示窗口，也不增加任务栏图标。</small>') : ""}
          ${platform?.custom ? tr('<small>本版自定义平台需在“平台设置”配置登录后专有标记，再验证登录。可在专用窗口内完成第三方登录；通用采集引擎不会自动证明登录身份。</small>') : ""}
        </div>
        <div class="linked-card-actions">
          ${platform?.custom ? tr`<button class="secondary-button edit-custom-platform" type="button" data-platform-id="${escapeHtml(account.platformId)}">平台设置</button>` : ""}
          <button class="secondary-button open-login" type="button" data-account-id="${escapeHtml(account.id)}">打开登录窗口</button>
          <button class="secondary-button verify-login" type="button" data-account-id="${escapeHtml(account.id)}">验证登录</button>
          <button class="danger-button remove-linked" type="button" data-account-id="${escapeHtml(account.id)}">移除</button>
        </div>
      </article>`;
  }).join(""));
}

function selectedFolderMode() {
  return document.querySelector('input[name="folder-mode"]:checked')?.value || "new";
}

function normalizePreviewName(value, fallback) {
  const cleaned = String(value || "").trim().replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "");
  return cleaned || fallback;
}

function renderFolderTree() {
  const name = normalizePreviewName(elements.personName.value, tr("人物名称"));
  const selectedPath = elements.selectedPath.value.trim();
  const folderMode = selectedFolderMode();
  const rootLabel = folderMode === "new" ? name : (selectedPath.split(/[\\/]/).filter(Boolean).at(-1) || name);

  setInterfaceHtml(elements.folderTree, tr`
    <div class="tree-line"><span class="tree-folder">▰ ${escapeHtml(rootLabel)}</span></div>
    <div class="tree-line">├─ <span class="tree-media">Image</span> <span class="tree-muted">图片 / GIF · 按需创建</span></div>
    <div class="tree-line">├─ <span class="tree-media">Video</span> <span class="tree-muted">视频 / MP4 动图 · 按需创建</span></div>
    <div class="tree-line">└─ <span class="tree-folder">Index</span> <span class="tree-muted">媒体与发布来源</span></div>
    <div class="tree-on-demand"><span>人物内统一保存</span>各平台和账号共用媒体目录，字节完全相同的文件只保存一份。Index 记录全部发布来源。</div>`);
}

function normalizedDownloadMedia(account) {
  return {
    image: account?.downloadMedia?.image !== false,
    video: account?.downloadMedia?.video !== false,
    gif: account?.downloadMedia?.gif !== false,
  };
}

function renderMediaChoices(media, prefix = "") {
  return [
    ["image", tr("图片")],
    ["video", tr("视频")],
    ["gif", "GIF"],
  ].map(([kind, label]) => `
    <label class="compact-check">
      <input type="checkbox" ${media[kind] ? "checked" : ""} ${prefix ? `data-${prefix}-media="${kind}"` : `data-media-kind="${kind}"`} />
      <span>${label}</span>
    </label>`).join("");
}

function renderHomepageCandidates() {
  if (state.homepageCandidates.length === 0) {
    setInterfaceHtml(elements.homepageCandidates, "");
    return;
  }

  const cards = state.homepageCandidates.map((item) => {
    const media = normalizedDownloadMedia(item);
    return tr`
      <article class="candidate-card" data-candidate-id="${escapeHtml(item.id)}">
        <label class="candidate-select">
          <input type="checkbox" data-candidate-field="selected" ${item.selected ? "checked" : ""} />
          <span class="candidate-platform">${escapeHtml(item.platformLabel)}</span>
        </label>
        <div class="candidate-identity">
          <strong>${escapeHtml(item.label)}</strong>
          <a href="${escapeHtml(item.profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(item.profileUrl)}</a>
          <small><span class="confidence-chip">直接链接</span>${escapeHtml(item.evidence)}</small>
        </div>
        <div class="candidate-policy">
          <div class="media-choice-group"><span>计划下载</span>${renderMediaChoices(media, "candidate")}</div>
          <label class="compact-check follow-choice">
            <input type="checkbox" data-candidate-field="followRequested" ${item.followRequested ? "checked" : ""} />
            <span>加入待关注</span>
          </label>
          <label class="candidate-session">
            <span>使用我的账号</span>
            <select data-candidate-field="linkedAccountId">${linkedAccountOptions(item.platformId, item.linkedAccountId)}</select>
          </label>
        </div>
      </article>`;
  }).join("");

  setInterfaceHtml(elements.homepageCandidates, tr`
    <div class="discovery-rail">
      <div><strong>发现 ${state.homepageCandidates.length} 个候选账号</strong><small>仅勾选需要采集的账号。</small></div>
      <button class="secondary-button apply-candidates" type="button">添加所选账号</button>
    </div>
    <div class="candidate-list">${cards}</div>`);
}

function renderPlatformEditor() {
  if (state.draftPlatforms.length === 0) {
    setInterfaceHtml(elements.platformEditor, tr`<p class="field-hint">尚未添加平台。</p>`);
    renderFolderTree();
    return;
  }

  setInterfaceHtml(elements.platformEditor, tr`<p class="field-hint account-sync-hint">暂停只跳过该账号的后续同步；登录绑定、已下载文件、历史来源及增量节点都会保留。恢复后从原成功节点继续。</p>` + state.draftPlatforms.map((platform) => {
    const info = state.platforms[platform.id] || platform;
    const rows = platform.accounts.map((account) => {
      const media = normalizedDownloadMedia(account);
      return tr`
      <div class="account-row" data-account-id="${escapeHtml(account.id)}" data-sync-state="${account.syncEnabled === false ? "paused" : "enabled"}">
        <div class="account-main-grid">
          <label><span>账号名称</span><input data-field="label" value="${escapeHtml(account.label)}" placeholder="例如：账号 A" /></label>
          <label><span>主页链接${info.custom ? tr("（测试采集必填）") : tr("（可选）")}</span><input data-field="profileUrl" value="${escapeHtml(account.profileUrl || "")}" placeholder="https://..." /></label>
          <label><span>用于查看的我的账号</span><select data-field="linkedAccountId">${linkedAccountOptions(platform.id, account.linkedAccountId)}</select></label>
          <button class="account-remove" type="button" aria-label="移除账号" title="移除账号">×</button>
        </div>
        <div class="account-policy-row">
          <label class="compact-check account-sync-choice" title="保存人物后生效；暂停不删除已采集内容或登录信息">
            <input type="checkbox" data-field="syncEnabled" aria-label="同步该账号" ${account.syncEnabled !== false ? "checked" : ""} />
            <span class="account-sync-status">${account.syncEnabled === false ? tr("已暂停") : tr("参与同步")}</span>
          </label>
          <div class="media-choice-group"><span>下载计划</span>${renderMediaChoices(media)}</div>
          <label class="compact-check follow-choice">
            <input type="checkbox" data-field="followRequested" ${account.followRequested ? "checked" : ""} />
            <span>加入待关注（执行前再次确认）</span>
          </label>
          ${account.discoveredFrom ? tr`<span class="discovery-origin">来自主页发现</span>` : ""}
        </div>
        ${info.custom ? renderCustomAccountTools(platform, account) : ""}
      </div>`;
    }).join("");
    return tr`
      <div class="platform-panel" data-platform-id="${escapeHtml(platform.id)}">
        <div class="platform-panel-head"><strong class="platform-display-label">${escapeHtml(info.label)}</strong><div>${info.custom ? tr('<button class="text-button edit-custom-platform" type="button">平台设置</button>') : ""}<button class="remove-link remove-platform" type="button">移除平台</button></div></div>
        ${customFollowingPageMissing(platform.id) ? tr('<p class="field-hint following-page-warning">请先在平台设置中添加该自定义平台的关注页。仅关注列表导入需要此设置，仍可手动添加账号和同步媒体。</p>') : ""}
        <div class="account-rows">${rows}<button class="add-account-button" type="button">＋ 添加另一个 ${escapeHtml(info.label)} 账号</button></div>
      </div>`;
  }).join(""));
  renderFolderTree();
}

function probeKey(platform, account) {
  return `${platform.id}/${account.id}`;
}

function renderCustomAccountTools(platform, account) {
  const probe = state.accountProbes.get(probeKey(platform, account));
  const resultText = probe?.result ? probeResultText(probe.result).text : probe?.error
    ? tr`${[401, 403].includes(probe.error.status) ? tr("需登录或检查访问权限") : tr("测试未完成")}：${tm(probe.error.message)}`
    : tm(probe?.text);
  const hasUrl = Boolean(account.profileUrl?.trim());
  return tr`<div class="custom-account-tools">
    <button class="secondary-button probe-account" type="button" ${!hasUrl || probe?.pending ? "disabled" : ""}>${probe?.pending ? tr("正在测试…") : tr("测试采集")}</button>
    <button class="secondary-button open-account-target" type="button" ${!hasUrl || !account.linkedAccountId ? "disabled" : ""}>打开目标主页</button>
    <p class="field-hint">测试只读取少量样本，不下载媒体，也不代表完整历史可读取。选择关联账号后，可在专用窗口中打开主页并自行关注。</p>
    <p class="account-probe-result" role="status" data-status="${escapeHtml(probe?.status || "idle")}" ${resultText ? "" : "hidden"}>${escapeHtml(resultText)}</p>
  </div>`;
}

function updateCustomAccountTools(platform, account) {
  const panel = [...elements.platformEditor.querySelectorAll(".platform-panel")].find((item) => item.dataset.platformId === platform.id);
  const row = [...(panel?.querySelectorAll(".account-row") || [])].find((item) => item.dataset.accountId === account.id);
  const tools = row?.querySelector(".custom-account-tools");
  if (tools) reconcileElement(tools, elementFromHtml(renderCustomAccountTools(platform, account)));
}

function probeResultText(result) {
  if (!result.ok) {
    const code = result.code || result.status || "";
    const title = /login|auth|session/.test(code) ? tr("需登录或重新验证") : /unsupported|no-extractor/.test(code) ? tr("暂不支持此链接") : tr("尚未确认可采集");
    return { status: "failed", text: tr`${title}。${tm(result.message) || tr("请检查目标链接、关联账号或采集方式。")}` };
  }
  if (!Number.isSafeInteger(result.mediaCount) || result.mediaCount <= 0) {
    return { status: "unconfirmed", text: tr`未取得媒体样本，尚不能确认可采集。${tm(result.message) || tr("请检查目标链接与访问权限；目标也可能暂时没有公开媒体。")}` };
  }
  const scope = result.capability?.scope;
  const title = scope === "single" ? tr("样本可读取，仅确认单条作品") : scope === "account" ? tr("样本可读取，已识别账号列表") : tr("样本可读取，范围尚未确认");
  const count = Number.isSafeInteger(result.mediaCount) && result.mediaCount >= 0 ? tr`（${result.mediaCount} 项媒体）` : "";
  return { status: "readable", text: tr`${title}${count}。\n${tm(result.message) || ""}${tm(result.message) ? "\n" : ""}此结果不代表账号的全部历史已可读取或已完成同步。` };
}

async function probeCustomAccount(platform, account) {
  const key = probeKey(platform, account);
  if (state.accountProbes.get(key)?.pending || !account.profileUrl?.trim()) return;
  const request = { pending: true, status: "pending", text: tr("正在读取少量样本，不下载媒体…") };
  state.accountProbes.set(key, request);
  updateCustomAccountTools(platform, account);
  try {
    const result = await api(`/api/platforms/${encodeURIComponent(platform.id)}/probe`, {
      method: "POST", body: JSON.stringify({ profileUrl: account.profileUrl.trim(), linkedAccountId: account.linkedAccountId || "" }),
    });
    if (state.accountProbes.get(key) !== request) return;
    state.accountProbes.set(key, { pending: false, result, ...probeResultText(result) });
  } catch (error) {
    if (state.accountProbes.get(key) !== request) return;
    state.accountProbes.set(key, { pending: false, status: "failed", error: { status: error.status, message: error.message } });
  }
  updateCustomAccountTools(platform, account);
}

async function openCustomAccountTarget(platform, account, button) {
  if (!account.profileUrl?.trim() || !account.linkedAccountId) return;
  button.disabled = true;
  try {
    const result = await api(`/api/linked-accounts/${encodeURIComponent(account.linkedAccountId)}/open-target`, {
      method: "POST", body: JSON.stringify({ profileUrl: account.profileUrl.trim() }),
    });
    showToast(tm(result.message) || tr("已在关联账号的专用窗口打开目标主页；可自行查看或关注，工具不会自动点击关注。"));
  } catch (error) { showToast(tm(error.message), true); }
  finally { if (button.isConnected) button.disabled = !account.profileUrl?.trim() || !account.linkedAccountId; }
}

function blankAccount() {
  return {
    id: crypto.randomUUID(),
    label: "",
    folderName: "",
    profileUrl: "",
    linkedAccountId: "",
    syncEnabled: true,
    followRequested: false,
    downloadMedia: { image: true, video: true, gif: true },
    discoveredFrom: "",
    discoveryEvidence: "",
  };
}

const followingImportPageSize = 75;
const followingJobActive = (job) => ["queued", "running"].includes(job?.status);

function followingHandle(platformId, value, profileUrl = "") {
  if (state.platforms[platformId]?.custom) {
    try {
      const url = new URL(profileUrl || value);
      url.hash = "";
      return url.href;
    } catch { return String(profileUrl || value || "").trim(); }
  }
  try {
    const url = new URL(profileUrl || (/^https?:\/\//i.test(value || "") ? value : ""));
    if (platformId === "facebook" && url.pathname === "/profile.php") return url.searchParams.get("id") || "";
    const parts = url.pathname.split("/").filter(Boolean);
    if (platformId === "facebook" && parts[0] === "people" && parts.length === 3) return parts[2];
    const segment = parts.length === 1 ? parts[0] : "";
    if (segment) return decodeURIComponent(segment).replace(/^@/, "").toLowerCase();
  } catch { /* A plain handle is also supported. */ }
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function followingImportKey(item) {
  return JSON.stringify([item.platformId, followingHandle(item.platformId, item.handle, item.profileUrl)]);
}

function followingVisibleAccounts(view = state.followingImport) {
  if (!view) return [];
  const query = elements.followingSearch.value.trim().toLocaleLowerCase();
  return [...view.accounts.values()].filter((item) => !query
    || [item.displayName, item.label, item.handle, item.profileUrl, state.platforms[item.platformId]?.label].join(" ").toLocaleLowerCase().includes(query));
}

function followingCurrentPage(view = state.followingImport) {
  const filtered = followingVisibleAccounts(view);
  const pageCount = Math.max(1, Math.ceil(filtered.length / followingImportPageSize));
  view.page = Math.max(0, Math.min(view.page, pageCount - 1));
  return { filtered, pageCount, accounts: filtered.slice(view.page * followingImportPageSize, (view.page + 1) * followingImportPageSize) };
}

function renderFollowingImport() {
  const view = state.followingImport;
  if (!view) return;
  const selectedSource = elements.followingSource.value || view.linkedAccountId;
  const sourceMarkup = state.linkedAccounts.length
    ? state.linkedAccounts.map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selectedSource ? "selected" : ""}>${escapeHtml(state.platforms[account.platformId]?.label || account.platformLabel || account.platformId)} · ${escapeHtml(account.label)}</option>`).join("")
    : tr('<option value="">请先在“我的账号”中添加登录绑定</option>');
  const sourceClone = elements.followingSource.cloneNode(false);
  sourceClone.innerHTML = sourceMarkup;
  reconcileElement(elements.followingSource, sourceClone);
  if (selectedSource && state.linkedAccounts.some((account) => account.id === selectedSource)) elements.followingSource.value = selectedSource;
  view.linkedAccountId = elements.followingSource.value;
  const source = state.linkedAccounts.find((account) => account.id === view.linkedAccountId);
  const supported = source && state.followingSupportedPlatformIds.includes(source.platformId);
  const missingFollowingPage = source && customFollowingPageMissing(source.platformId);
  const active = view.starting || followingJobActive(view.job);
  const jobHasNoAccounts = !Array.isArray(view.job?.accounts) || view.job.accounts.length === 0;
  const confirmedEmpty = !active && !view.error && view.job?.status === "completed"
    && jobHasNoAccounts && Array.isArray(view.job.accounts) && (view.job.discovered ?? 0) === 0 && view.job.emptyConfirmed === true;
  // Older services may return a completed empty parse without zero-list
  // evidence. Do not present that as success even before the service restarts.
  const unconfirmedEmpty = !active && !view.error && view.job?.status === "completed"
    && jobHasNoAccounts && !confirmedEmpty;
  elements.followingSource.disabled = active;
  elements.followingRead.disabled = active || !supported || missingFollowingPage;
  elements.followingSettings.hidden = !source || !state.platforms[source.platformId]?.custom;
  elements.followingSettings.disabled = active;
  elements.followingStop.hidden = !active;
  elements.followingStop.disabled = view.cancelling || view.starting || view.job?.cancelRequested === true;
  elements.followingStop.textContent = view.cancelling || view.job?.cancelRequested ? tr("正在停止读取…") : tr("停止读取");
  let status = view.error || view.job?.error || view.job?.message || (source
    ? tr("选择登录绑定后，点击“读取关注列表”。") : tr("请先在“我的账号”中添加登录绑定，再回到这里导入。"));
  if (!active && source && !supported) status = tr("此平台暂不支持读取关注列表，可在人物草稿中手动添加账号。");
  if (!active && missingFollowingPage) status = tr("请先在平台设置中添加该自定义平台的关注页。仅关注列表导入需要此设置，仍可手动添加账号和同步媒体。");
  if (view.starting) status = tr("正在准备读取关注列表…");
  if (view.cancelling || view.job?.cancelRequested && active) status = tr("正在停止读取，已读取账号和选择会保留。");
  if (confirmedEmpty) status = tr("当前登录账号的关注列表为空（平台已确认），可手动添加目标账号。");
  if (unconfirmedEmpty) status = tr("平台未提供可读取的已关注列表，请确认当前账号能查看自己的关注列表。");
  if (view.job?.completeness === "partial" && !active && (view.job.discovered ?? view.job.accounts?.length ?? 0) > 0) status = `${tm(status)} ${tr("仅取得当前可读取的部分关注账号，不代表完整列表。")}`;
  elements.followingStatus.textContent = tm(status);
  elements.followingStatus.classList.toggle("is-error", Boolean(view.error || view.job?.status === "failed" || unconfirmedEmpty));
  const { filtered, accounts, pageCount } = followingCurrentPage(view);
  let emptyMessage = tr("读取后在这里勾选需要加入当前人物的账号。");
  if (active) emptyMessage = tr("正在读取关注列表，尚未返回可选择的账号。");
  else if (confirmedEmpty) emptyMessage = tr("当前登录账号的关注列表为空（平台已确认），可手动添加目标账号。");
  else if (view.error || view.job?.status === "failed" || unconfirmedEmpty) emptyMessage = tr("尚未读取到可选择的账号。请重新读取，或手动添加目标账号。");
  else if (view.job?.status === "cancelled") emptyMessage = tr("读取已停止，尚未读取到可选择的账号。可重新读取或手动添加目标账号。");
  const markup = accounts.length ? accounts.map((item) => {
    const key = followingImportKey(item);
    const account = state.linkedAccounts.find((linked) => linked.id === item.linkedAccountId);
    return tr`<label class="following-import-item" data-render-key="${escapeHtml(key)}">
      <input type="checkbox" data-following-key="${escapeHtml(key)}" ${view.selected.has(key) ? "checked" : ""} />
      <span class="following-import-identity"><strong>${escapeHtml(item.displayName || item.label || item.handle)}</strong><span class="following-import-handle">${escapeHtml(state.platforms[item.platformId]?.label || item.platformId)} · ${escapeHtml(item.handle)}</span><small>${escapeHtml(item.profileUrl)}</small></span>
      <span class="following-import-binding">${escapeHtml(account?.label || tr("登录绑定已移除"))}</span>
    </label>`;
  }).join("") : tr`<div class="following-import-empty">${view.accounts.size ? tr("没有匹配的账号，请调整搜索内容。") : emptyMessage}</div>`;
  const next = elements.followingList.cloneNode(false);
  next.innerHTML = markup;
  reconcileElement(elements.followingList, next);
  for (const input of elements.followingList.querySelectorAll("input[data-following-key]")) input.checked = view.selected.has(input.dataset.followingKey);
  elements.followingList.setAttribute("aria-busy", String(active));
  elements.followingPage.textContent = tr`已读取 ${view.accounts.size} 个账号 · 匹配 ${filtered.length} 个 · 第 ${view.page + 1} / ${pageCount} 页`;
  elements.followingSelected.textContent = tr`已选择 ${view.selected.size} 个账号`;
  elements.followingSelectVisible.disabled = accounts.length === 0;
  elements.followingClear.disabled = view.selected.size === 0;
  elements.followingPrevious.disabled = view.page === 0;
  elements.followingNext.disabled = view.page + 1 >= pageCount;
  elements.followingApply.disabled = view.selected.size === 0;
}

function acceptFollowingImportJob(view, job, linkedAccountId) {
  if (!job || state.followingImport !== view || view.closed) return;
  view.job = job;
  const linked = state.linkedAccounts.find((account) => account.id === linkedAccountId);
  for (const item of Array.isArray(job.accounts) ? job.accounts : []) {
    if (typeof item.handle !== "string" || !item.handle.trim() || !state.platforms[item.platformId]
      || item.platformId !== linked?.platformId) continue;
    const candidate = { platformId: item.platformId, handle: item.handle.trim(), label: String(item.label || item.handle), displayName: String(item.displayName || item.label || item.handle),
      profileUrl: String(item.profileUrl || ""), linkedAccountId };
    const key = followingImportKey(candidate);
    if (!view.accounts.has(key)) view.accounts.set(key, candidate);
  }
  renderFollowingImport();
}

function scheduleFollowingImportPoll(view) {
  window.clearTimeout(view.timer);
  if (view.closed || appPageClosed || !followingJobActive(view.job)) return;
  const sequence = view.pollSequence || 0;
  view.timer = window.setTimeout(async () => {
    try {
      const result = await api(`/api/following-imports/${encodeURIComponent(view.job.id)}`);
      if (state.followingImport !== view || view.closed || sequence !== (view.pollSequence || 0)) return;
      view.error = "";
      acceptFollowingImportJob(view, result.job, view.job.linkedAccountId || view.linkedAccountId);
      scheduleFollowingImportPoll(view);
    } catch (error) {
      if (state.followingImport !== view || view.closed || sequence !== (view.pollSequence || 0)) return;
      view.error = tm(error.message);
      if ([404, 410, 503].includes(error.status)) view.job = { ...view.job, status: "failed", error: view.error };
      renderFollowingImport();
      scheduleFollowingImportPoll(view);
    }
  }, 700);
}

async function stopFollowingImport(view = state.followingImport) {
  if (!view || !followingJobActive(view.job) || view.cancelling) return;
  view.cancelling = true;
  view.pollSequence = (view.pollSequence || 0) + 1;
  window.clearTimeout(view.timer);
  if (!view.closed) renderFollowingImport();
  try {
    const result = await api(`/api/following-imports/${encodeURIComponent(view.job.id)}`, { method: "DELETE", body: "{}" });
    if (!view.closed && state.followingImport === view) acceptFollowingImportJob(view, result.job, view.job.linkedAccountId || view.linkedAccountId);
  } catch (error) {
    view.error = tm(error.message);
  } finally {
    view.cancelling = false;
    if (!view.closed && state.followingImport === view) {
      renderFollowingImport();
      scheduleFollowingImportPoll(view);
    }
  }
}

function openFollowingImport() {
  if (!elements.personDialog.open) return;
  if (!state.followingImport) state.followingImport = { accounts: new Map(), selected: new Set(), page: 0, job: null, error: "", linkedAccountId: "" };
  state.followingImport.closed = false;
  renderFollowingImport();
  elements.followingDialog.showModal();
  elements.followingSource.focus();
}

function closeFollowingImport() {
  const view = state.followingImport;
  if (view) {
    view.closed = true;
    view.requestSequence = (view.requestSequence || 0) + 1;
    view.pollSequence = (view.pollSequence || 0) + 1;
    window.clearTimeout(view.timer);
    void stopFollowingImport(view);
  }
  if (elements.followingDialog.open) elements.followingDialog.close();
  elements.importFollowingButton.focus({ preventScroll: true });
}

async function readFollowingImport() {
  const view = state.followingImport;
  const linkedAccountId = elements.followingSource.value;
  if (!view || !linkedAccountId || view.starting || followingJobActive(view.job)) return;
  const source = state.linkedAccounts.find(account => account.id === linkedAccountId);
  if (!source || customFollowingPageMissing(source.platformId) || !state.followingSupportedPlatformIds.includes(source.platformId)) {
    renderFollowingImport();
    return;
  }
  view.starting = true;
  const requestSequence = view.requestSequence = (view.requestSequence || 0) + 1;
  view.error = "";
  view.job = null;
  renderFollowingImport();
  try {
    const result = await api("/api/following-imports", { method: "POST", body: JSON.stringify({ linkedAccountId }) });
    if (!result.job?.id) throw new Error(tr("关注列表任务响应不完整，请重试。"));
    if (state.followingImport !== view || view.closed || requestSequence !== view.requestSequence) {
      if (followingJobActive(result.job)) await api(`/api/following-imports/${encodeURIComponent(result.job.id)}`, { method: "DELETE", body: "{}" });
      return;
    }
    acceptFollowingImportJob(view, result.job, linkedAccountId);
    scheduleFollowingImportPoll(view);
  } catch (error) {
    if (!view.closed && state.followingImport === view && requestSequence === view.requestSequence) view.error = error.status === 404
      ? tr("后台服务尚未提供关注列表导入，请完整退出工具后重新打开新版。") : tm(error.message);
  } finally {
    view.starting = false;
    if (!view.closed && state.followingImport === view) renderFollowingImport();
  }
}

function applyFollowingImport() {
  const view = state.followingImport;
  if (!view || !elements.personDialog.open) return;
  const selected = [...view.selected].map((key) => view.accounts.get(key)).filter(Boolean);
  if (selected.some((item) => !state.platforms[item.platformId]
    || !state.linkedAccounts.some((account) => account.id === item.linkedAccountId && account.platformId === item.platformId))) {
    view.error = tr("导入来源的登录绑定已移除或平台已改变，请重新读取或在人物草稿中手动添加。");
    renderFollowingImport();
    return;
  }
  let added = 0, existingCount = 0;
  for (const item of selected) {
    let platform = state.draftPlatforms.find((entry) => entry.id === item.platformId);
    if (!platform) {
      platform = { id: item.platformId, label: state.platforms[item.platformId].label, accounts: [] };
      state.draftPlatforms.push(platform);
    }
    const handle = followingHandle(item.platformId, item.handle, item.profileUrl);
    const existing = platform.accounts.find((account) => followingHandle(item.platformId, account.label, account.profileUrl) === handle);
    if (existing) {
      // Rediscovery must never change a pause, download policy or an intentional login binding.
      if (!existing.profileUrl) existing.profileUrl = item.profileUrl;
      if (!existing.linkedAccountId) existing.linkedAccountId = item.linkedAccountId;
      existingCount += 1;
      continue;
    }
    const label = state.platforms[item.platformId].custom ? item.label : item.handle;
    platform.accounts.push({ ...blankAccount(), label, folderName: label,
      profileUrl: item.profileUrl, linkedAccountId: item.linkedAccountId });
    added += 1;
  }
  if (selected.length === 1 && !elements.personName.value.trim()) elements.personName.value = selected[0].displayName || selected[0].label || selected[0].handle;
  view.selected.clear();
  renderPlatformEditor();
  closeFollowingImport();
  showToast(tr`已加入当前人物草稿：${added} 个新账号，${existingCount} 个已有账号。保存人物后生效。`);
}

function openPersonDialog(person = null) {
  if (state.followingImport) {
    state.followingImport.closed = true;
    window.clearTimeout(state.followingImport.timer);
    void stopFollowingImport(state.followingImport);
  }
  state.followingImport = null;
  elements.followingSearch.value = "";
  elements.followingSource.value = "";
  state.accountProbes.clear();
  state.editingPersonId = person?.id || null;
  state.draftPlatforms = person
    ? structuredClone(person.platforms)
    : [];
  elements.personName.value = person?.name || "";
  elements.personNote.value = person?.note || "";
  elements.homepageUrl.value = person?.homepageUrl || "";
  state.homepageCandidates = [];
  state.homepageAnalysis = person?.homepageAnalysis ? structuredClone(person.homepageAnalysis) : null;
  elements.homepageStatus.textContent = person?.homepageAnalysis
    ? tr`上次分析：${new Date(person.homepageAnalysis.scannedAt).toLocaleString(uiLocale())}，发现 ${person.homepageAnalysis.candidateCount} 个候选账号。可再次分析以刷新。`
    : tr("只读取该网页公开呈现的社交账号链接，不会根据姓名猜测同名账号。");
  elements.selectedPath.value = person?.folderPath || "";
  elements.formStatus.textContent = "";
  elements.dialogEyebrow.textContent = person ? tr("修改人物") : tr("新人物");
  elements.dialogTitle.textContent = person ? tr`修改 ${person.name}` : tr("建立采集账号");
  elements.savePersonButton.textContent = person ? tr("保存修改") : tr("创建人物");

  const newRadio = document.querySelector('input[name="folder-mode"][value="new"]');
  const existingRadio = document.querySelector('input[name="folder-mode"][value="existing"]');
  if (person) {
    existingRadio.checked = true;
    newRadio.disabled = true;
    elements.folderModeOptions.classList.add("is-editing");
  } else {
    newRadio.checked = true;
    newRadio.disabled = false;
    elements.folderModeOptions.classList.remove("is-editing");
  }
  updatePathHint();
  renderHomepageCandidates();
  renderPlatformEditor();
  elements.personDialog.showModal();
  elements.personName.focus();
}

function closePersonDialog() {
  if (state.followingImport) closeFollowingImport();
  state.followingImport = null;
  elements.personDialog.close();
  state.editingPersonId = null;
  state.draftPlatforms = [];
  state.homepageCandidates = [];
  state.homepageAnalysis = null;
  state.accountProbes.clear();
}

function updatePathHint() {
  elements.pathHint.textContent = selectedFolderMode() === "new"
    ? tr("请选择父目录，工具将在其中新建人物名称文件夹。")
    : tr("请选择人物文件夹。各平台、账号的媒体统一保存到其 Image、Video 子目录，来源保存在 Index。");
  renderFolderTree();
}

function syncDraftFromEditor(event) {
  const platformPanel = event.target.closest(".platform-panel");
  const accountRow = event.target.closest(".account-row");
  if (!platformPanel || !accountRow) return;
  const platform = state.draftPlatforms.find((item) => item.id === platformPanel.dataset.platformId);
  const account = platform?.accounts.find((item) => item.id === accountRow.dataset.accountId);
  if (!account) return;
  const mediaKind = event.target.dataset.mediaKind;
  if (mediaKind) {
    account.downloadMedia = normalizedDownloadMedia(account);
    account.downloadMedia[mediaKind] = event.target.checked;
    return;
  }
  const field = event.target.dataset.field;
  if (!field) return;
  const nextValue = event.target.type === "checkbox" ? event.target.checked : event.target.value;
  const changed = account[field] !== nextValue;
  account[field] = nextValue;
  if (field === "syncEnabled") {
    accountRow.dataset.syncState = nextValue ? "enabled" : "paused";
    accountRow.querySelector(".account-sync-status").textContent = nextValue ? tr("参与同步") : tr("已暂停");
  }
  if (changed && ["profileUrl", "linkedAccountId"].includes(field)) {
    state.accountProbes.delete(probeKey(platform, account));
    if (state.platforms[platform.id]?.custom) updateCustomAccountTools(platform, account);
  }
  renderFolderTree();
}

async function refreshState() {
  const sequence = ++stateRefreshSequence;
  const dedupVersion = dedupStatusVersion;
  const featureVersion = featureStatusVersion;
  const versions = new Map(syncSummaryVersions);
  const payload = await api("/api/state");
  if (sequence !== stateRefreshSequence) return;
  state.linkedAccounts = payload.linkedAccounts;
  state.persons = payload.persons;
  state.platforms = payload.platforms;
  if (Array.isArray(payload.importFollowingSupportedPlatformIds)) state.followingSupportedPlatformIds = payload.importFollowingSupportedPlatformIds;
  state.settings = { theme: "system", language: "system", ...payload.settings };
  if (pendingThemePreference !== null) state.settings.theme = pendingThemePreference;
  else savedThemePreference = state.settings.theme;
  if (pendingLanguagePreference !== null) state.settings.language = pendingLanguagePreference;
  else savedLanguagePreference = state.settings.language;
  state.runtime = payload.runtime || state.runtime;
  if (payload.features?.dedup) acceptDedupFeature(payload.features.dedup, featureVersion);
  state.recentPaths = payload.recentPaths || [];
  const summaries = { ...(payload.syncSummaries || {}) };
  for (const person of state.persons) {
    if (syncSummaryVersions.get(person.id) !== versions.get(person.id) && state.syncSummaries[person.id]) {
      summaries[person.id] = state.syncSummaries[person.id];
    }
  }
  state.syncSummaries = summaries;
  if (payload.dedupStatus) { acceptDedupStatus(payload.dedupStatus, dedupVersion); ensureDedupPolling(); }
  if (state.contextFile?.fileId) {
    const cached = state.newFilesByPerson.get(state.contextFile.personId);
    if (summaries[state.contextFile.personId]?.id !== cached?.jobId) closeFileContextMenu();
  }
  if (state.sourceBrowser && !state.persons.some((person) => person.id === state.sourceBrowser.personId)) closeSourcesDialog();
  if (state.mediaBrowser && !state.persons.some((person) => person.id === state.mediaBrowser.personId)) closeMediaDialog();
  for (const [personId, cached] of state.newFilesByPerson) {
    if (state.syncSummaries[personId]?.id !== cached.jobId) {
      state.newFilesByPerson.delete(personId);
      state.expandedNewFilePersonIds.delete(personId);
    }
  }
  applyTheme(state.settings.theme);
  applyLanguage(state.settings.language);
  confirmSystemLanguage();
  refreshPlatformOptions();
  setInterfaceHtml(elements.recentPaths, state.recentPaths
    .map((recentPath) => `<option value="${escapeHtml(recentPath)}"></option>`)
    .join(""));
  renderPeople();
  renderLinkedAccounts();
}

elements.navItems.forEach((item) => item.addEventListener("click", () => switchView(item.dataset.view)));
elements.cachePreviewButton.addEventListener("click", scanCache);
elements.cacheCleanButton.addEventListener("click", cleanCache);
elements.cacheRemoveProfilesButton.addEventListener("click", removeUnlinkedProfiles);
elements.cacheProfileList.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-removal-id]");
  const cache = state.cacheMaintenance;
  if (!input || cache.loading || cache.cleaning || cache.removing) return;
  if (input.checked) cache.selectedProfiles.add(input.dataset.removalId);
  else cache.selectedProfiles.delete(input.dataset.removalId);
  updateCacheControls();
});
elements.createPersonButton.addEventListener("click", () => openPersonDialog());
elements.importFollowingButton.addEventListener("click", openFollowingImport);
elements.platformToAdd.addEventListener("change", renderPersonFollowingHint);
elements.personFollowingSettings.addEventListener("click", () => openCustomPlatformDialog("person", elements.platformToAdd.value, elements.personFollowingSettings));
elements.followingSettings.addEventListener("click", () => {
  const source = state.linkedAccounts.find(account => account.id === elements.followingSource.value);
  if (source) openCustomPlatformDialog("following", source.platformId, elements.followingSettings);
});
elements.followingClose.addEventListener("click", closeFollowingImport);
elements.followingCancel.addEventListener("click", closeFollowingImport);
elements.followingDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeFollowingImport(); });
elements.followingRead.addEventListener("click", () => void readFollowingImport());
elements.followingStop.addEventListener("click", () => void stopFollowingImport());
elements.followingSource.addEventListener("change", () => {
  if (!state.followingImport) return;
  state.followingImport.linkedAccountId = elements.followingSource.value;
  state.followingImport.error = "";
  if (!followingJobActive(state.followingImport.job) && state.followingImport.job?.linkedAccountId !== elements.followingSource.value) state.followingImport.job = null;
  renderFollowingImport();
});
elements.followingSearch.addEventListener("input", () => {
  if (!state.followingImport) return;
  state.followingImport.page = 0;
  renderFollowingImport();
});
elements.followingList.addEventListener("change", (event) => {
  const input = event.target.closest("input[data-following-key]");
  const view = state.followingImport;
  if (!input || !view?.accounts.has(input.dataset.followingKey)) return;
  if (input.checked) view.selected.add(input.dataset.followingKey);
  else view.selected.delete(input.dataset.followingKey);
  renderFollowingImport();
});
elements.followingSelectVisible.addEventListener("click", () => {
  const view = state.followingImport;
  if (!view) return;
  for (const item of followingCurrentPage(view).accounts) view.selected.add(followingImportKey(item));
  renderFollowingImport();
});
elements.followingClear.addEventListener("click", () => { state.followingImport?.selected.clear(); renderFollowingImport(); });
elements.followingPrevious.addEventListener("click", () => { if (state.followingImport) state.followingImport.page -= 1; renderFollowingImport(); });
elements.followingNext.addEventListener("click", () => { if (state.followingImport) state.followingImport.page += 1; renderFollowingImport(); });
elements.followingApply.addEventListener("click", applyFollowingImport);
elements.createPersonPlatformButton.addEventListener("click", () => openCustomPlatformDialog("person"));
elements.createLinkedPlatformButton.addEventListener("click", () => openCustomPlatformDialog("linked"));
elements.closePlatformDialog.addEventListener("click", closeCustomPlatformDialog);
elements.cancelPlatformDialog.addEventListener("click", closeCustomPlatformDialog);
elements.platformDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeCustomPlatformDialog(); });
elements.platformForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.creatingPlatform) return;
  const editingId = state.editingPlatformId;
  const source = state.customPlatformSource;
  const body = {
    label: elements.customPlatformLabel.value.trim(),
    homepageUrl: elements.customPlatformHomepage.value.trim(),
    loginUrl: elements.customPlatformLogin.value.trim() || elements.customPlatformHomepage.value.trim(),
    followingUrl: elements.customPlatformFollowing.value.trim(),
    engine: elements.customPlatformEngine.value,
    verificationUrl: elements.customPlatformVerification.value.trim(),
    loginMarker: elements.customPlatformLoginMarker.value.trim(),
    logoutMarker: elements.customPlatformLogoutMarker.value.trim(),
  };
  state.creatingPlatform = true;
  elements.savePlatformButton.disabled = true;
  elements.closePlatformDialog.disabled = true;
  elements.cancelPlatformDialog.disabled = true;
  elements.platformFormStatus.textContent = editingId ? tr("正在保存平台设置…") : tr("正在创建平台…");
  try {
    const result = await api(editingId ? `/api/platforms/${encodeURIComponent(editingId)}` : "/api/platforms", {
      method: editingId ? "PUT" : "POST", body: JSON.stringify(body),
    });
    if (!result.platform?.id) throw new Error(tr("平台响应不完整，请重新载入后确认是否已经创建。"));
    // Do not reload or rebuild the person form: it may contain unsaved accounts.
    stateRefreshSequence += 1;
    state.platforms = { ...state.platforms, ...(result.platforms || {}), [result.platform.id]: result.platform };
    if (Array.isArray(result.importFollowingSupportedPlatformIds)) state.followingSupportedPlatformIds = result.importFollowingSupportedPlatformIds;
    if (Array.isArray(result.linkedAccounts)) state.linkedAccounts = result.linkedAccounts;
    refreshPlatformOptions({
      personSelection: !editingId && source === "person" ? result.platform.id : elements.platformToAdd.value,
      linkedSelection: !editingId && source === "linked" ? result.platform.id : elements.linkedPlatform.value,
    });
    for (const panel of elements.platformEditor.querySelectorAll(".platform-panel")) {
      const platformId = panel.dataset.platformId;
      const info = state.platforms[platformId];
      if (!info) continue;
      panel.querySelector(".platform-display-label").textContent = info.label;
      panel.querySelector(".add-account-button").textContent = tr`＋ 添加另一个 ${info.label} 账号`;
      const followingWarning = panel.querySelector(".following-page-warning");
      if (!customFollowingPageMissing(platformId)) followingWarning?.remove();
      else if (!followingWarning) panel.querySelector(".platform-panel-head").insertAdjacentHTML("afterend", tr('<p class="field-hint following-page-warning">请先在平台设置中添加该自定义平台的关注页。仅关注列表导入需要此设置，仍可手动添加账号和同步媒体。</p>'));
      const draft = state.draftPlatforms.find((item) => item.id === platformId);
      for (const row of panel.querySelectorAll(".account-row")) {
        const account = draft?.accounts.find((item) => item.id === row.dataset.accountId);
        if (!account) continue;
        row.querySelector('[data-field="linkedAccountId"]').innerHTML = linkedAccountOptions(platformId, account.linkedAccountId);
        if (editingId === platformId) {
          state.accountProbes.delete(probeKey(draft, account));
          updateCustomAccountTools(draft, account);
        }
      }
    }
    renderFolderTree();
    renderLinkedAccounts();
    state.creatingPlatform = false;
    closeCustomPlatformDialog();
    showToast(editingId ? tr("平台设置已保存；验证规则变更后请重新验证登录。已有目录不会移动。") : tr("平台已创建，可在人物和我的账号中选择。请用目标链接测试采集能力。"));
  } catch (error) {
    elements.platformFormStatus.textContent = tm(error.message);
  } finally {
    state.creatingPlatform = false;
    elements.savePlatformButton.disabled = false;
    elements.closePlatformDialog.disabled = false;
    elements.cancelPlatformDialog.disabled = false;
  }
});
elements.syncAllButton.addEventListener("click", async () => {
  if (elements.syncAllButton.disabled || dedupBusy()) return;
  const previousJobs = new Map(state.persons.map((person) => [person.id, state.syncSummaries[person.id]?.id]));
  state.syncAllLaunching = true;
  renderSyncAllControl();
  try {
    const result = await api("/api/sync-all", { method: "POST" });
    for (const job of result.jobs) {
      acceptStartedSync(job, previousJobs.get(job.personId));
      updatePersonCard(job.personId);
    }
    state.syncAllLaunching = false;
    renderSyncAllControl();
    result.jobs.forEach(ensureSyncPolling);
    const reused = result.existingCount ? tr`；${result.existingCount} 个已有任务继续运行` : "";
    showToast(tr`已为 ${result.startedCount} 个人物加入同步队列${reused}。`);
  } catch (error) {
    state.syncAllLaunching = false;
    renderSyncAllControl();
    showToast(tm(error.message), true);
  }
});
elements.dedupAllButton.addEventListener("click", () => void startDeduplication());
elements.dedupCancelButton.addEventListener("click", cancelDeduplication);
elements.dedupCloseButton.addEventListener("click", closeDedupResults);
elements.dedupContinueButton.addEventListener("click", () => {
  const job = state.deduplication.job;
  if (!job || !["cancelled", "failed"].includes(job.status) || elements.dedupContinueButton.disabled) return;
  void startDeduplication(job.scope === "person" ? job.personId : null);
});
elements.dedupDetails.addEventListener("toggle", () => { if (!elements.dedupDetails.open) renderDedupResults(); });
elements.closeDialogButton.addEventListener("click", closePersonDialog);
elements.cancelPersonButton.addEventListener("click", closePersonDialog);
elements.personDialog.addEventListener("cancel", (event) => { event.preventDefault(); closePersonDialog(); });
elements.personName.addEventListener("input", renderFolderTree);
elements.selectedPath.addEventListener("input", renderFolderTree);
elements.folderModeOptions.addEventListener("change", updatePathHint);
systemTheme.addEventListener("change", () => {
  if (state.settings.theme === "system") applyTheme("system");
});
elements.themeControl.addEventListener("change", (event) => {
  const theme = event.target.value;
  if (!["system", "light", "dark"].includes(theme)) return;
  const sequence = ++themeSaveSequence;
  pendingThemePreference = theme;
  state.settings.theme = theme;
  applyTheme(theme);
  themeSaveQueue = themeSaveQueue.then(async () => {
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ theme }) });
      savedThemePreference = theme;
      if (sequence === themeSaveSequence) pendingThemePreference = null;
    } catch {
      if (sequence !== themeSaveSequence) return;
      pendingThemePreference = null;
      state.settings.theme = savedThemePreference;
      applyTheme(savedThemePreference);
      showToast(tr("无法保存界面主题，已恢复上次设置。"), true);
    }
  });
});

elements.languageControl?.addEventListener("change", (event) => {
  const language = event.target.value;
  if (!["system", "zh", "en"].includes(language)) return;
  const sequence = ++languageSaveSequence;
  pendingLanguagePreference = language;
  state.settings.language = language;
  applyLanguage(language);
  languageSaveQueue = languageSaveQueue.then(async () => {
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ language }) });
      savedLanguagePreference = language;
      if (sequence === languageSaveSequence) pendingLanguagePreference = null;
    } catch (error) {
      if (sequence !== languageSaveSequence) return;
      pendingLanguagePreference = null;
      state.settings.language = savedLanguagePreference;
      applyLanguage(savedLanguagePreference);
      showToast(tr("无法保存界面语言，已恢复上次设置。"), true);
    }
  });
});

elements.pickFolderButton.addEventListener("click", async () => {
  elements.pickFolderButton.disabled = true;
  elements.pickFolderButton.textContent = tr("等待选择…");
  try {
    const result = await api("/api/folders/pick", {
      method: "POST",
      body: JSON.stringify({ initialPath: elements.selectedPath.value.trim() }),
    });
    if (result.selectedPath) {
      elements.selectedPath.value = result.selectedPath;
      if (!state.recentPaths.includes(result.selectedPath)) state.recentPaths.unshift(result.selectedPath);
      setInterfaceHtml(elements.recentPaths, state.recentPaths
        .slice(0, 12)
        .map((recentPath) => `<option value="${escapeHtml(recentPath)}"></option>`)
        .join(""));
      renderFolderTree();
    }
  } catch (error) {
    showToast(tm(error.message), true);
  } finally {
    elements.pickFolderButton.disabled = false;
    elements.pickFolderButton.textContent = tr("Windows 浏览");
  }
});

elements.analyzeHomepageButton.addEventListener("click", async () => {
  const url = elements.homepageUrl.value.trim();
  if (!url) {
    elements.homepageStatus.textContent = tr("请先填写个人主页网址。");
    return;
  }

  elements.analyzeHomepageButton.disabled = true;
  elements.analyzeHomepageButton.textContent = tr("正在分析…");
  elements.homepageStatus.textContent = tr("正在读取主页中的公开社交链接…");
  state.homepageCandidates = [];
  renderHomepageCandidates();
  try {
    const result = await api("/api/homepages/analyze", {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    elements.homepageUrl.value = result.sourceUrl;
    state.homepageAnalysis = {
      sourceUrl: result.sourceUrl,
      finalUrl: result.finalUrl,
      title: result.title,
      scannedAt: result.scannedAt,
      candidateCount: result.candidates.length,
    };
    state.homepageCandidates = result.candidates.map((item) => ({
      ...item,
      selected: true,
      followRequested: false,
      linkedAccountId: "",
      downloadMedia: { image: true, video: true, gif: true },
    }));
    elements.homepageStatus.textContent = result.candidates.length
      ? tr`分析完成：${result.title || new URL(result.finalUrl).hostname}，发现 ${result.candidates.length} 个直接关联的账号。`
      : tr("分析完成，但没有发现支持平台的直接账号链接。你仍可以在下方手动添加账号。");
    renderHomepageCandidates();
  } catch (error) {
    state.homepageAnalysis = null;
    elements.homepageStatus.textContent = tm(error.message);
    showToast(tm(error.message), true);
  } finally {
    elements.analyzeHomepageButton.disabled = false;
    elements.analyzeHomepageButton.textContent = tr("分析主页账号");
  }
});

elements.homepageCandidates.addEventListener("change", (event) => {
  const card = event.target.closest(".candidate-card");
  if (!card) return;
  const item = state.homepageCandidates.find((candidateItem) => candidateItem.id === card.dataset.candidateId);
  if (!item) return;

  const mediaKind = event.target.dataset.candidateMedia;
  if (mediaKind) {
    item.downloadMedia = normalizedDownloadMedia(item);
    item.downloadMedia[mediaKind] = event.target.checked;
    return;
  }
  const field = event.target.dataset.candidateField;
  if (!field) return;
  item[field] = event.target.type === "checkbox" ? event.target.checked : event.target.value;
});

elements.homepageCandidates.addEventListener("click", (event) => {
  if (!event.target.closest(".apply-candidates")) return;
  const selected = state.homepageCandidates.filter((item) => item.selected);
  if (selected.length === 0) {
    showToast(tr("请至少勾选一个候选账号。"), true);
    return;
  }

  let added = 0;
  let updated = 0;
  for (const item of selected) {
    const media = normalizedDownloadMedia(item);
    let platform = state.draftPlatforms.find((draftPlatform) => draftPlatform.id === item.platformId);
    if (!platform) {
      platform = { id: item.platformId, label: state.platforms[item.platformId].label, accounts: [] };
      state.draftPlatforms.push(platform);
    }
    const normalizedUrl = item.profileUrl.replace(/\/$/, "").toLowerCase();
    const existing = platform.accounts.find((account) =>
      account.profileUrl?.replace(/\/$/, "").toLowerCase() === normalizedUrl
      || account.label.toLowerCase() === item.label.toLowerCase());
    if (existing) {
      existing.followRequested ||= item.followRequested;
      existing.downloadMedia = {
        image: normalizedDownloadMedia(existing).image || media.image,
        video: normalizedDownloadMedia(existing).video || media.video,
        gif: normalizedDownloadMedia(existing).gif || media.gif,
      };
      if (item.linkedAccountId) existing.linkedAccountId = item.linkedAccountId;
      existing.discoveredFrom ||= state.homepageAnalysis?.sourceUrl || elements.homepageUrl.value.trim();
      existing.discoveryEvidence ||= item.evidence;
      updated += 1;
    } else {
      platform.accounts.push({
        id: crypto.randomUUID(),
        label: item.label,
        folderName: item.label,
        profileUrl: item.profileUrl,
        linkedAccountId: item.linkedAccountId,
        syncEnabled: true,
        followRequested: item.followRequested,
        downloadMedia: media,
        discoveredFrom: state.homepageAnalysis?.sourceUrl || elements.homepageUrl.value.trim(),
        discoveryEvidence: item.evidence,
      });
      added += 1;
    }
    item.selected = false;
  }
  renderHomepageCandidates();
  renderPlatformEditor();
  showToast(tr`已添加 ${added} 个账号${updated ? tr`，更新 ${updated} 个已有账号` : ""}。保存人物后生效。`);
});

elements.addPlatformButton.addEventListener("click", () => {
  const platformId = elements.platformToAdd.value;
  if (!state.platforms[platformId]) return;
  if (state.draftPlatforms.some((platform) => platform.id === platformId)) {
    showToast(tr("该平台已经添加；请在平台卡片中继续添加账号。"), true);
    return;
  }
  state.draftPlatforms.push({ id: platformId, label: state.platforms[platformId].label, folderName: state.platforms[platformId].folderName, accounts: [blankAccount()] });
  renderPlatformEditor();
});

elements.platformEditor.addEventListener("input", syncDraftFromEditor);
elements.platformEditor.addEventListener("change", syncDraftFromEditor);
elements.platformEditor.addEventListener("click", (event) => {
  const platformPanel = event.target.closest(".platform-panel");
  if (!platformPanel) return;
  const platformIndex = state.draftPlatforms.findIndex((platform) => platform.id === platformPanel.dataset.platformId);
  if (platformIndex < 0) return;

  if (event.target.closest(".edit-custom-platform")) {
    openCustomPlatformDialog("person", platformPanel.dataset.platformId, event.target.closest("button"));
    return;
  }
  const probeButton = event.target.closest(".probe-account");
  const openTargetButton = event.target.closest(".open-account-target");
  if (probeButton || openTargetButton) {
    const platform = state.draftPlatforms[platformIndex];
    const row = event.target.closest(".account-row");
    const account = platform.accounts.find((item) => item.id === row?.dataset.accountId);
    if (!account) return;
    if (probeButton) void probeCustomAccount(platform, account);
    else void openCustomAccountTarget(platform, account, openTargetButton);
    return;
  }

  if (event.target.closest(".remove-platform")) {
    state.draftPlatforms.splice(platformIndex, 1);
    renderPlatformEditor();
    return;
  }
  if (event.target.closest(".add-account-button")) {
    state.draftPlatforms[platformIndex].accounts.push(blankAccount());
    renderPlatformEditor();
    return;
  }
  const removeButton = event.target.closest(".account-remove");
  if (removeButton) {
    const accountRow = removeButton.closest(".account-row");
    const accounts = state.draftPlatforms[platformIndex].accounts;
    if (accounts.length === 1) {
      showToast(tr("每个平台至少保留一个账号；如不需要该平台，请移除整个平台。"), true);
      return;
    }
    state.draftPlatforms[platformIndex].accounts = accounts.filter((account) => account.id !== accountRow.dataset.accountId);
    renderPlatformEditor();
  }
});

elements.personForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.formStatus.textContent = "";
  if (!elements.selectedPath.value.trim()) {
    elements.formStatus.textContent = tr("请先选择本地文件夹。");
    return;
  }
  if (state.draftPlatforms.length === 0) {
    elements.formStatus.textContent = tr("请至少添加一个社交媒体平台和账号。");
    return;
  }

  const platforms = state.draftPlatforms.map((platform) => ({
    ...platform,
    accounts: platform.accounts.map((account) => ({
      ...account,
      syncEnabled: account.syncEnabled !== false,
      folderName: account.folderName || account.label,
    })),
  }));
  const payload = {
    name: elements.personName.value,
    note: elements.personNote.value,
    homepageUrl: elements.homepageUrl.value,
    homepageAnalysis: state.homepageAnalysis,
    folderMode: selectedFolderMode(),
    selectedPath: elements.selectedPath.value,
    platforms,
  };
  const editing = Boolean(state.editingPersonId);
  elements.savePersonButton.disabled = true;
  elements.savePersonButton.textContent = editing ? tr("正在保存…") : tr("正在创建…");
  try {
    await api(editing ? `/api/persons/${state.editingPersonId}` : "/api/persons", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closePersonDialog();
    await refreshState();
    showToast(editing ? tr("人物信息已更新，媒体继续统一保存到人物目录。") : tr("人物已创建，媒体目录将在首次下载时按需建立。"));
  } catch (error) {
    elements.formStatus.textContent = tm(error.message);
  } finally {
    elements.savePersonButton.disabled = false;
    elements.savePersonButton.textContent = editing ? tr("保存修改") : tr("创建人物");
  }
});

// Keep this fallback local and restore the selection/focus: it is only used
// when Chromium's async clipboard permission is unavailable or rejected.
function copyReceiptTextFallback(text) {
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const focused = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("aria-hidden", "true");
  input.setAttribute("data-window-no-drag", "");
  input.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0;pointer-events:none";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    input.remove();
    focused?.focus?.({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
    }
  }
}

async function copyReceiptDetails(button) {
  if (button.disabled) return;
  const panel = button.closest("details.sync-errors");
  const text = [panel?.querySelector("summary")?.innerText, panel?.querySelector("ul")?.innerText]
    .filter(Boolean).join("\n").trim();
  if (!text) return;
  const restoreButtonFocus = document.activeElement === button;
  button.dataset.actionPending = "true";
  button.disabled = true;
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); copied = true; } catch { /* Try the local Chromium fallback. */ }
    }
    if (!copied) copyReceiptTextFallback(text);
    if (!appPageClosed) showToast(tr("已复制当前展开的记录。"));
  } catch {
    if (!appPageClosed) showToast(tr("复制失败，请选中文字后按 Ctrl+C。"), true);
  } finally {
    delete button.dataset.actionPending;
    button.disabled = false;
    if (restoreButtonFocus && button.isConnected && document.activeElement === document.body) button.focus({ preventScroll: true });
  }
}

elements.peopleList.addEventListener("click", async (event) => {
  const copyButton = event.target.closest(".copy-sync-details");
  if (copyButton) { await copyReceiptDetails(copyButton); return; }
  const folderButton = event.target.closest(".open-person-folder");
  if (folderButton) {
    if (folderButton.disabled || folderButton.hasAttribute("data-action-pending")) return;
    const personId = folderButton.dataset.personId;
    if (!state.persons.some((person) => person.id === personId)) return;
    folderButton.dataset.actionPending = "true";
    folderButton.disabled = true;
    folderButton.textContent = tr("正在打开文件夹…");
    try {
      const result = await api(`/api/persons/${encodeURIComponent(personId)}/open-folder`, { method: "POST" });
      if (!appPageClosed) showToast(result.foreground ? tr("已在文件资源管理器中打开人物文件夹。")
        : tr("人物文件夹已打开；如果未显示在最前面，请查看任务栏。"));
    } catch (error) {
      if (!appPageClosed) showToast(error.status === 404
        ? tr("查看文件功能尚未加载，请在同步结束后完全退出工具，再从原快捷方式重新打开。") : tm(error.message), true);
    } finally {
      delete folderButton.dataset.actionPending;
      folderButton.disabled = false;
      folderButton.textContent = tr("查看文件");
      if (!appPageClosed) updatePersonCard(personId);
    }
    return;
  }
  const postButton = event.target.closest(".open-bound-post");
  if (postButton) { await openBoundPost(postButton); return; }
  const recheckButton = event.target.closest(".recheck-person");
  if (recheckButton) {
    if (recheckButton.disabled || dedupBusy()) return;
    const personId = recheckButton.dataset.personId;
    const person = state.persons.find((item) => item.id === personId);
    if (!person || ["queued", "running"].includes(state.syncSummaries[personId]?.status)) return;
    const previousJobId = state.syncSummaries[personId]?.id;
    recheckButton.dataset.actionPending = "true";
    recheckButton.disabled = true;
    try {
      const confirmed = await requestConfirmation({ title: tr`立即完整补查“${person.name}”？`, tone: "neutral", confirmLabel: tr("开始完整补查"),
        message: tr("仅此操作重新读取此人物所有账号的历史分页，并尝试补充已记录的缺失附件，不等待 24 小时补查间隔。常规同步不会自动完整补查。已有完整文件直接跳过，不清空索引、不重新绑定账号；可能比增量同步耗时更长。网站没有返回的内容保留技术记录，不作为人工待办。") });
      if (!confirmed || appPageClosed) return;
      recheckButton.textContent = tr("正在开始补查…");
      const job = await api(`/api/persons/${encodeURIComponent(personId)}/recheck`, { method: "POST", body: JSON.stringify({ confirm: true }) });
      if (acceptStartedSync(job, previousJobId)) ensureSyncPolling(job);
      showToast(job.forceHistory === true ? tr("完整补查已开始，已有完整媒体会直接跳过。")
        : tr("此人物已有同步任务运行；本次没有新建完整补查。请等待当前同步结束后再点击完整补查。"));
    } catch (error) {
      showToast(error.status === 404 ? tr("后台服务尚未提供完整补查，请关闭工具后重新启动新版。") : tm(error.message), true);
    } finally {
      delete recheckButton.dataset.actionPending;
      updatePersonCard(personId);
      renderSyncAllControl();
    }
    return;
  }
  const dedupButton = event.target.closest(".dedup-person");
  if (dedupButton) {
    if (dedupButton.disabled) return;
    if (personDedupActive(dedupButton.dataset.personId)) await cancelDeduplication();
    else await startDeduplication(dedupButton.dataset.personId);
    return;
  }
  const dedupFileName = event.target.closest(".dedup-file-name");
  if (dedupFileName) {
    await openDedupReviewFile(dedupFileName);
    return;
  }
  const sourcesButton = event.target.closest(".file-sources-button");
  if (sourcesButton) {
    openSourcesDialog({ ...sourcesButton.dataset, trigger: sourcesButton });
    return;
  }
  const mediaButton = event.target.closest(".browse-person-media");
  if (mediaButton) {
    const person = state.persons.find((item) => item.id === mediaButton.dataset.personId);
    if (person) openMediaDialog(person, mediaButton);
    return;
  }
  const newFileName = event.target.closest(".new-file-name");
  if (newFileName) {
    newFileName.dataset.actionPending = "true";
    newFileName.disabled = true;
    try {
      await runNewFileAction("open", newFileName.dataset.personId, newFileName.dataset.fileId);
    } catch (error) {
      showToast(tm(error.message), true);
    } finally {
      delete newFileName.dataset.actionPending;
      newFileName.disabled = false;
    }
    return;
  }

  const newFilesToggle = event.target.closest(".new-files-toggle");
  if (newFilesToggle) {
    const personId = newFilesToggle.dataset.personId;
    if (state.expandedNewFilePersonIds.has(personId)) {
      state.expandedNewFilePersonIds.delete(personId);
      updatePersonCard(personId);
    } else {
      state.expandedNewFilePersonIds.add(personId);
      await loadNewFiles(personId);
    }
    return;
  }

  const editButton = event.target.closest(".edit-person");
  if (editButton) {
    const person = state.persons.find((item) => item.id === editButton.dataset.personId);
    if (person) openPersonDialog(person);
    return;
  }

  const deleteButton = event.target.closest(".delete-person");
  if (deleteButton) {
    const person = state.persons.find((item) => item.id === deleteButton.dataset.personId);
    if (person) await deletePerson(person);
    return;
  }

  const syncButton = event.target.closest(".sync-person");
  if (syncButton) {
    if (syncButton.disabled || dedupBusy()) return;
    const personId = syncButton.dataset.personId;
    const previousJobId = state.syncSummaries[personId]?.id;
    syncButton.dataset.actionPending = "true";
    syncButton.disabled = true;
    syncButton.textContent = tr("启动中…");
    try {
      const job = await api(`/api/persons/${personId}/sync`, { method: "POST" });
      if (acceptStartedSync(job, previousJobId)) ensureSyncPolling(job);
      showToast(tr("同步已开始，可在人物卡片查看实时进度。 "));
    } catch (error) {
      showToast(tm(error.message), true);
    } finally {
      delete syncButton.dataset.actionPending;
      updatePersonCard(personId);
      renderSyncAllControl();
    }
    return;
  }

  const cancelButton = event.target.closest(".cancel-sync");
  if (cancelButton) {
    const personId = cancelButton.dataset.personId;
    const jobId = cancelButton.dataset.jobId;
    cancelButton.dataset.actionPending = "true";
    cancelButton.disabled = true;
    try {
      const job = await api(`/api/sync-jobs/${jobId}/cancel`, { method: "POST" });
      if (acceptSyncSummary(job, jobId)) ensureSyncPolling(job);
    } catch (error) {
      showToast(tm(error.message), true);
    } finally {
      delete cancelButton.dataset.actionPending;
      updatePersonCard(personId);
      renderSyncAllControl();
    }
  }
});

elements.peopleList.addEventListener("toggle", (event) => {
  if (event.target.matches("details.sync-errors") && !event.target.open) {
    updatePersonCard(event.target.closest(".person-card").dataset.personId);
  }
}, true);

elements.peopleList.addEventListener("contextmenu", (event) => {
  const fileName = event.target.closest(".new-file-name, .dedup-file-name");
  if (!fileName) return;
  event.preventDefault();
  openFileContextMenu(fileName, event.clientX, event.clientY);
});

elements.peopleList.addEventListener("keydown", (event) => {
  const fileName = event.target.closest(".new-file-name, .dedup-file-name");
  if (!fileName || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
  event.preventDefault();
  const bounds = fileName.getBoundingClientRect();
  openFileContextMenu(fileName, bounds.left + 16, bounds.bottom - 2);
});

async function openDedupReviewFile(button) {
  if (button.disabled) return;
  button.dataset.actionPending = "true";
  button.disabled = true;
  try {
    await runMediaFileAction("open", button.dataset.personId, button.dataset.mediaId);
  } catch (error) {
    showToast(tm(error.message), true);
  } finally {
    delete button.dataset.actionPending;
    button.disabled = false;
  }
}

elements.dedupResultList.addEventListener("click", (event) => {
  const fileName = event.target.closest(".dedup-file-name");
  if (fileName) void openDedupReviewFile(fileName);
});
elements.dedupResultList.addEventListener("contextmenu", (event) => {
  const fileName = event.target.closest(".dedup-file-name");
  if (!fileName) return;
  event.preventDefault();
  openFileContextMenu(fileName, event.clientX, event.clientY);
});
elements.dedupResultList.addEventListener("keydown", (event) => {
  const fileName = event.target.closest(".dedup-file-name");
  if (!fileName || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
  event.preventDefault();
  const bounds = fileName.getBoundingClientRect();
  openFileContextMenu(fileName, bounds.left + 16, bounds.bottom - 2);
});

elements.revealFileLocationButton.addEventListener("click", async () => {
  const selected = state.contextFile;
  if (!selected) return;
  elements.revealFileLocationButton.disabled = true;
  try {
    if (selected.fileId) await runNewFileAction("reveal", selected.personId, selected.fileId);
    else await runMediaFileAction("reveal", selected.personId, selected.mediaId);
    closeFileContextMenu();
  } catch (error) {
    showToast(tm(error.message), true);
    if (elements.mediaDialog.open) {
      elements.mediaListStatus.textContent = tm(error.message);
      elements.mediaListStatus.classList.add("is-error");
    }
  } finally {
    elements.revealFileLocationButton.disabled = false;
  }
});

elements.viewFileSourcesButton.addEventListener("click", () => {
  const selected = state.contextFile;
  if (selected?.mediaId) openSourcesDialog(selected);
});
elements.closeMediaDialog.addEventListener("click", closeMediaDialog);
elements.mediaDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeMediaDialog(); });
elements.closeSourcesDialog.addEventListener("click", closeSourcesDialog);
elements.sourcesDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeSourcesDialog(); });
elements.mediaSearchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadMediaPage({ query: elements.mediaSearch.value, offset: 0 });
});
elements.mediaSearch.addEventListener("input", () => {
  const view = state.mediaBrowser;
  if (!view) return;
  // Invalidate already-running requests immediately, before the debounce fires.
  view.sequence += 1;
  window.clearTimeout(view.searchTimer);
  view.searchTimer = window.setTimeout(() => void loadMediaPage({ query: elements.mediaSearch.value, offset: 0 }), 250);
});
elements.refreshMediaList.addEventListener("click", () => void loadMediaPage({ query: elements.mediaSearch.value }));
elements.mediaPreviousPage.addEventListener("click", () => {
  const view = state.mediaBrowser;
  if (view) void loadMediaPage({ offset: Math.max(0, view.offset - view.limit) });
});
elements.mediaNextPage.addEventListener("click", () => {
  const view = state.mediaBrowser;
  if (view) void loadMediaPage({ offset: view.offset + view.limit });
});
elements.mediaList.addEventListener("click", async (event) => {
  const sourcesButton = event.target.closest(".file-sources-button");
  if (sourcesButton) {
    openSourcesDialog({ ...sourcesButton.dataset, trigger: sourcesButton });
    return;
  }
  const fileName = event.target.closest(".media-file-name");
  if (!fileName) return;
  fileName.disabled = true;
  try {
    await runMediaFileAction("open", fileName.dataset.personId, fileName.dataset.mediaId);
  } catch (error) {
    elements.mediaListStatus.textContent = tm(error.message);
    elements.mediaListStatus.classList.add("is-error");
    showToast(tm(error.message), true);
  } finally { fileName.disabled = false; }
});
elements.mediaList.addEventListener("contextmenu", (event) => {
  const fileName = event.target.closest(".media-file-name");
  if (!fileName) return;
  event.preventDefault();
  openFileContextMenu(fileName, event.clientX, event.clientY);
});
elements.mediaList.addEventListener("keydown", (event) => {
  const fileName = event.target.closest(".media-file-name");
  if (!fileName || !(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
  event.preventDefault();
  const bounds = fileName.getBoundingClientRect();
  openFileContextMenu(fileName, bounds.left + 16, bounds.bottom - 2);
});
elements.sourcesList.addEventListener("click", (event) => {
  const postButton = event.target.closest(".open-bound-post");
  if (postButton) { void openBoundPost(postButton); return; }
  if (event.target.closest(".retry-file-sources")) void loadFileSources();
});
elements.fileContextMenu.addEventListener("keydown", (event) => {
  const buttons = [...elements.fileContextMenu.querySelectorAll("button:not(:disabled)")];
  const current = buttons.indexOf(document.activeElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  } else if (event.key === "Tab") closeFileContextMenu();
});

document.addEventListener("pointerdown", (event) => {
  pressedPersonId = event.target.closest(".person-card")?.dataset.personId || null;
  if (!elements.fileContextMenu.hidden && !elements.fileContextMenu.contains(event.target)) closeFileContextMenu();
});
// Release after the click handler has captured the file id. The timer also
// handles releasing outside the card, where no click will reach the list.
document.addEventListener("pointerup", () => window.setTimeout(releasePersonUpdates, 0));
document.addEventListener("click", () => { if (pressedPersonId) queueMicrotask(releasePersonUpdates); });
document.addEventListener("pointercancel", releasePersonUpdates);
document.addEventListener("lostpointercapture", () => window.setTimeout(releasePersonUpdates, 0));
window.addEventListener("blur", releasePersonUpdates);
window.addEventListener("resize", closeFileContextMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.fileContextMenu.hidden) {
    event.preventDefault();
    closeFileContextMenu({ restoreFocus: true });
  }
});

elements.linkedAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submitButton = elements.linkedAccountForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    await api("/api/linked-accounts", {
      method: "POST",
      body: JSON.stringify({
        platformId: elements.linkedPlatform.value,
        label: elements.linkedLabel.value,
      }),
    });
    elements.linkedLabel.value = "";
    await refreshState();
    showToast(tr("账号关联已创建。请打开登录窗口完成登录。 "));
  } catch (error) {
    showToast(tm(error.message), true);
  } finally {
    submitButton.disabled = false;
  }
});

elements.linkedAccountsList.addEventListener("click", async (event) => {
  const settingsButton = event.target.closest(".edit-custom-platform");
  if (settingsButton) {
    openCustomPlatformDialog("linked", settingsButton.dataset.platformId, settingsButton);
    return;
  }
  const openButton = event.target.closest(".open-login");
  const verifyButton = event.target.closest(".verify-login");
  const removeButton = event.target.closest(".remove-linked");
  const button = openButton || verifyButton || removeButton;
  if (!button) return;
  button.disabled = true;
  try {
    if (openButton) {
      const result = await api(`/api/linked-accounts/${button.dataset.accountId}/open-login`, { method: "POST" });
      showToast(tm(result.loginMessage) || tr("已打开普通登录窗口。完成登录后请关闭该窗口，再回到工具点击“验证登录”。 "));
    } else if (verifyButton) {
      const result = await api(`/api/linked-accounts/${button.dataset.accountId}/verify-login`, { method: "POST" });
      showToast(result.verified ? (tm(result.loginMessage) || tr("登录验证通过。")) : `${result.loginCode === "login-rule-required" ? tr("登录验证待配置") : tr("登录验证未通过")}：${tm(result.loginMessage)}`, !result.verified);
    } else {
      const confirmed = await requestConfirmation({
        title: tr("移除账号关联？"),
        message: tr("只会删除工具中的关联记录，不会删除工具的独立登录资料夹。"),
      });
      if (!confirmed) return;
      await api(`/api/linked-accounts/${button.dataset.accountId}`, { method: "DELETE" });
      showToast(tr("账号关联已移除，工具的独立登录资料夹仍保留。 "));
    }
    await refreshState();
  } catch (error) {
    showToast(tm(error.message), true);
  } finally {
    button.disabled = false;
  }
});

refreshState().catch((error) => {
  showToast(tr`无法读取本地数据：${tm(error.message)}`, true);
});
window.addEventListener("pagehide", () => {
  appPageClosed = true;
  if (state.followingImport) {
    state.followingImport.closed = true;
    state.followingImport.requestSequence = (state.followingImport.requestSequence || 0) + 1;
    window.clearTimeout(state.followingImport.timer);
  }
  window.clearTimeout(dedupPollTimer);
  window.clearTimeout(featurePollTimer);
  for (const timer of syncPollTimers.values()) window.clearTimeout(timer);
  syncPollTimers.clear();
  window.clearTimeout(state.mediaBrowser?.searchTimer);
  window.clearTimeout(showToast.timer);
  window.clearTimeout(systemLanguageTimer);
  window.clearTimeout(nativeWindowPollTimer);
});
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  appPageClosed = false;
  ensureDedupFeaturePolling();
  void queryNativeWindowState();
  scheduleNativeWindowState();
  void refreshState().catch((error) => showToast(tm(error.message), true));
});
