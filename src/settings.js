// @ts-check
/**
 * Message Collapser — Settings panel.
 * Mount/unmount of settings.html into the extensions drawer, DOM ↔ settings
 * sync, and the control change handlers. Conditional fields (preview lines,
 * thresholds) and the master-toggle dimming live purely in CSS via :has();
 * all ids stay in the DOM read-only.
 */

import { FOLDER_NAME, eventNamespace, getSettings, getCtx, saveSettings, warn, log } from './core.js';
import { migrateLegacyCollapsedState } from './state.js';
import { startObserver, onChatChanged, destroy, bindArrowHandlers } from './collapse.js';
import {
    handleCollapseAllClick, handleExpandAllClick,
    handleCollapseHiddenClick, handleExpandHiddenClick,
    handleCollapseUserClick, handleExpandUserClick,
    handleCollapseCharacterClick, handleExpandCharacterClick,
    handleCollapseSystemClick, handleExpandSystemClick,
} from './bulk.js';

let _settingsPanelLoaded = false;

// CSS variable driving the number of preview lines. Set on :root so it
// applies to every message the extension touches.
function applyPreviewLines(previewLines) {
    const lines = Number.isFinite(previewLines) && previewLines > 0 ? previewLines : 2;
    document.documentElement.style.setProperty('--mc-preview-lines', String(lines));
}

/** Push the current settings into the panel controls (idempotent). */
export function syncSettingsUi(settings) {
    $('#mc_master_enable').prop('checked', settings.isEnabled);

    $('#mc_preview_mode').val(settings.previewMode || 'hide');
    $('#mc_preview_lines').val(settings.previewLines ?? 2);
    applyPreviewLines(settings.previewLines);

    $('#mc_auto_collapse_hidden').prop('checked', Boolean(settings.autoCollapseHidden));
    $('#mc_auto_collapse_by_length').prop('checked', Boolean(settings.autoCollapseByLength));
    $('#mc_length_threshold').val(settings.lengthThreshold ?? 1000);

    $('#mc_auto_collapse_by_age').prop('checked', Boolean(settings.autoCollapseByAge));
    $('#mc_age_threshold').val(settings.ageThreshold ?? 20);
}

// ── Change handlers ──

function handleMasterEnableToggleChange(event) {
    const settings = getSettings();
    settings.isEnabled = Boolean($(event.target).prop('checked'));
    saveSettings();

    if (settings.isEnabled) {
        startObserver();
        bindArrowHandlers();
        onChatChanged();
    } else {
        destroy();
    }
}

function handlePreviewModeChange(event) {
    const settings = getSettings();
    settings.previewMode = $(event.target).val();
    saveSettings();
    onChatChanged();
}

function handlePreviewLinesChange(event) {
    const settings = getSettings();
    const value = parseInt($(event.target).val());
    settings.previewLines = Number.isNaN(value) ? 2 : Math.max(1, Math.min(10, value));
    applyPreviewLines(settings.previewLines);
    saveSettings();
    onChatChanged();
}

function handleAutoCollapseHiddenChange(event) {
    const settings = getSettings();
    settings.autoCollapseHidden = Boolean($(event.target).prop('checked'));
    saveSettings();
    onChatChanged();
}

function handleAutoCollapseByLengthChange(event) {
    const settings = getSettings();
    settings.autoCollapseByLength = Boolean($(event.target).prop('checked'));
    saveSettings();
    onChatChanged();
}

function handleLengthThresholdChange(event) {
    const settings = getSettings();
    const value = parseInt($(event.target).val());
    settings.lengthThreshold = Number.isNaN(value) ? 1000 : Math.max(100, value);
    saveSettings();
    onChatChanged();
}

function handleAutoCollapseByAgeChange(event) {
    const settings = getSettings();
    settings.autoCollapseByAge = Boolean($(event.target).prop('checked'));
    saveSettings();
    onChatChanged();
}

function handleAgeThresholdChange(event) {
    const settings = getSettings();
    const value = parseInt($(event.target).val());
    settings.ageThreshold = Number.isNaN(value) ? 20 : Math.max(1, value);
    saveSettings();
    onChatChanged();
}

// Bind every panel control in one place, namespaced. .off(ns) before .on(ns)
// makes re-binding safe (no doubled listeners on re-init).
function bindSettingsHandlers() {
    const ns = eventNamespace;
    $('#mc_master_enable').off('change' + ns).on('change' + ns, handleMasterEnableToggleChange);

    $('#mc_preview_mode').off('change' + ns).on('change' + ns, handlePreviewModeChange);
    $('#mc_preview_lines').off('change' + ns).on('change' + ns, handlePreviewLinesChange);

    $('#mc_auto_collapse_hidden').off('change' + ns).on('change' + ns, handleAutoCollapseHiddenChange);
    $('#mc_auto_collapse_by_length').off('change' + ns).on('change' + ns, handleAutoCollapseByLengthChange);
    $('#mc_length_threshold').off('change' + ns).on('change' + ns, handleLengthThresholdChange);

    $('#mc_auto_collapse_by_age').off('change' + ns).on('change' + ns, handleAutoCollapseByAgeChange);
    $('#mc_age_threshold').off('change' + ns).on('change' + ns, handleAgeThresholdChange);

    $('#mc_collapse_all').off('click' + ns).on('click' + ns, handleCollapseAllClick);
    $('#mc_expand_all').off('click' + ns).on('click' + ns, handleExpandAllClick);

    $('#mc_collapse_hidden').off('click' + ns).on('click' + ns, handleCollapseHiddenClick);
    $('#mc_expand_hidden').off('click' + ns).on('click' + ns, handleExpandHiddenClick);

    $('#mc_collapse_user').off('click' + ns).on('click' + ns, handleCollapseUserClick);
    $('#mc_expand_user').off('click' + ns).on('click' + ns, handleExpandUserClick);

    $('#mc_collapse_character').off('click' + ns).on('click' + ns, handleCollapseCharacterClick);
    $('#mc_expand_character').off('click' + ns).on('click' + ns, handleExpandCharacterClick);

    $('#mc_collapse_system').off('click' + ns).on('click' + ns, handleCollapseSystemClick);
    $('#mc_expand_system').off('click' + ns).on('click' + ns, handleExpandSystemClick);
}

/**
 * Fetch settings.html via ST's template renderer and mount it into the
 * extensions drawer. Idempotent: the load flag flips only after a real
 * append, so a failed init retries on the next one.
 */
export async function mountSettingsPanel() {
    if (_settingsPanelLoaded) return;
    const { renderExtensionTemplateAsync } = getCtx();
    const settingsHtml = await renderExtensionTemplateAsync(
        `third-party/${FOLDER_NAME}`,
        'settings',
    );

    // Already in the DOM (re-init without unmount): skip the insert.
    if ($('#mc_master_enable').length === 0) {
        const host = document.getElementById('extensions_settings');
        if (!host) {
            warn('settings host #extensions_settings not found — retry on next init');
            return;
        }
        host.insertAdjacentHTML('beforeend', settingsHtml);
    }

    _settingsPanelLoaded = true;
    syncSettingsUi(getSettings());
    migrateLegacyCollapsedState(getSettings().collapsedMessages);
    bindSettingsHandlers();
}

/** Remove the panel from the DOM and allow a fresh mount on the next init. */
export function unmountSettingsPanel() {
    if (!_settingsPanelLoaded) return;
    $('.mc_settings').remove();
    _settingsPanelLoaded = false;
    log('settings panel unmounted');
}
