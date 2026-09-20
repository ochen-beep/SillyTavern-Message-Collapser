// @ts-check
/**
 * Message Collapser — State module.
 * Pure collapse-state logic, isolated from SillyTavern and the DOM: every
 * dependency (extension_settings, chat array, DOM element) is passed in as an
 * argument. Keeping this module dependency-free makes the persistence rules
 * (stable keys, manual-over-auto priority, migrations) reviewable in one place.
 */

export const defaultSettings = Object.freeze({
    isEnabled: false,
    collapsedMessages: {},
    manuallyExpandedMessages: {},
    previewMode: 'hide',        // 'hide' | 'preview'
    previewLines: 2,
    autoCollapseHidden: true,   // off = prompt-hidden messages are fully manual (no auto rule touches them)
    autoCollapseByLength: false,
    lengthThreshold: 1000,
    autoCollapseByAge: false,
    ageThreshold: 20,
});

/**
 * Create or backfill the extension's settings object with default keys.
 * Mutates in place (idempotent) and returns the settings object.
 * @param {Record<string, any>} extensionSettings ST extension_settings bag.
 * @param {string} moduleName key under extension_settings.
 */
export function buildSettings(extensionSettings, moduleName) {
    if (!extensionSettings[moduleName]) {
        extensionSettings[moduleName] = { ...defaultSettings };
    }
    const settings = extensionSettings[moduleName];
    for (const key of Object.keys(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = defaultSettings[key];
        }
    }
    return settings;
}

/**
 * Stable per-message key derived from send_date.
 * mesElement — a .mes node carrying the mesid attribute; chat — ST chat array.
 * @param {any[]} chat
 * @param {HTMLElement} mesElement
 * @returns {string | null}
 */
export function getStableMessageKey(chat, mesElement) {
    const mesId = parseInt(mesElement.getAttribute('mesid'));
    if (isNaN(mesId)) return null;
    const message = chat?.[mesId];
    const sendDate = message?.send_date;
    return sendDate ? String(sendDate) : null;
}

/**
 * @param {Record<string, Record<string, boolean>>} collapsedMessages
 * @param {string} chatId
 * @param {string | null} key
 */
export function isManuallyCollapsed(collapsedMessages, chatId, key) {
    return Boolean(key && collapsedMessages?.[chatId]?.[key]);
}

/**
 * Persist or remove the manual collapsed state of one message. Returns true
 * when something actually changed; the caller owns saveSettingsDebounced.
 * @returns {boolean}
 */
export function saveCollapsedState(settings, chatId, key, collapsed) {
    if (!chatId || !key || !settings) return false;
    if (!settings.collapsedMessages) settings.collapsedMessages = {};
    if (!settings.collapsedMessages[chatId]) settings.collapsedMessages[chatId] = {};

    const map = settings.collapsedMessages[chatId];
    let changed = false;
    if (collapsed) {
        if (!map[key]) { map[key] = true; changed = true; }
    } else {
        if (map[key]) { delete map[key]; changed = true; }
    }
    return changed;
}

/**
 * @param {Record<string, Record<string, boolean>>} expandedMessages
 * @param {string} chatId
 * @param {string | null} key
 */
export function isManuallyExpanded(expandedMessages, chatId, key) {
    return Boolean(key && expandedMessages?.[chatId]?.[key]);
}

/**
 * Persist the manually-expanded state of one message.
 * @returns {boolean}
 */
export function saveManuallyExpandedState(settings, chatId, key, expanded) {
    if (!chatId || !key || !settings) return false;
    if (!settings.manuallyExpandedMessages) settings.manuallyExpandedMessages = {};
    if (!settings.manuallyExpandedMessages[chatId]) settings.manuallyExpandedMessages[chatId] = {};

    const map = settings.manuallyExpandedMessages[chatId];
    let changed = false;
    if (expanded) {
        if (!map[key]) { map[key] = true; changed = true; }
    } else {
        if (map[key]) { delete map[key]; changed = true; }
    }
    return changed;
}

/**
 * Atomically toggle the manual state: collapse adds to collapsedMessages and
 * removes from manuallyExpandedMessages; expand does the inverse.
 * @returns {boolean} true when either map changed.
 */
export function saveManualToggleState(settings, chatId, key, collapsed) {
    const collapsedChanged = saveCollapsedState(settings, chatId, key, collapsed);
    const expandedChanged = saveManuallyExpandedState(settings, chatId, key, !collapsed);
    return collapsedChanged || expandedChanged;
}

/**
 * Atomically toggle the manual state of a set of messages (collapse/expand by
 * sender). Returns true when at least one key changed. Skips null/empty keys
 * and never touches other chats.
 *
 * Priority invariant of shouldCollapseMessage (collapsed > expanded): on
 * expand the key MUST leave collapsedMessages, or the next onChatChanged
 * collapses the message back. Expand therefore goes through
 * saveManuallyExpandedState(expanded=true), which atomically drops the key
 * from collapsed — never through a bare write into the expanded map.
 * @returns {boolean}
 */
export function setMessagesBulkToggle(settings, chatId, keys, collapsed) {
    if (!chatId || !settings || !keys) return false;
    let changed = false;
    for (const key of keys) {
        if (!key) continue;
        if (saveManualToggleState(settings, chatId, key, collapsed)) {
            changed = true;
        }
    }
    return changed;
}

/**
 * Drop the manual state of a chat (used by Expand All).
 * @returns {boolean}
 */
export function clearManualStateForChat(settings, chatId) {
    if (!chatId || !settings) return false;
    let changed = false;
    if (settings.collapsedMessages?.[chatId]) {
        delete settings.collapsedMessages[chatId];
        changed = true;
    }
    if (settings.manuallyExpandedMessages?.[chatId]) {
        delete settings.manuallyExpandedMessages[chatId];
        changed = true;
    }
    return changed;
}

/**
 * One-time migration of the settings key after the project rename:
 * move extension_settings[legacyName] → extension_settings[moduleName].
 * Idempotent; call before the first buildSettings() so a fresh default key
 * can't shadow the legacy data.
 * @param {Record<string, any>} extensionSettings ST extension_settings bag.
 * @param {string} moduleName current settings key.
 * @param {string} legacyName pre-rename settings key.
 * @returns {boolean} true when a migration happened.
 */
export function migrateSettingsKey(extensionSettings, moduleName, legacyName) {
    if (!extensionSettings?.[legacyName]) return false;
    if (!extensionSettings[moduleName]) {
        extensionSettings[moduleName] = extensionSettings[legacyName];
    }
    delete extensionSettings[legacyName];
    return true;
}

/**
 * One-time migration of the legacy format { chatId: [ids] } → { chatId: { id: true } }.
 * @param {Record<string, any>} collapsedMessages
 * @returns {boolean} true when at least one chat was migrated.
 */
export function migrateLegacyCollapsedState(collapsedMessages) {
    if (!collapsedMessages) return false;
    let migrated = false;
    for (const chatId in collapsedMessages) {
        if (Array.isArray(collapsedMessages[chatId])) {
            const map = {};
            for (const id of collapsedMessages[chatId]) map[id] = true;
            collapsedMessages[chatId] = map;
            migrated = true;
        }
    }
    return migrated;
}

/**
 * Lazy migration of positional keys (mesid) → stable keys (send_date),
 * per chat. Returns true when this chat was migrated.
 *
 * send_date is a timestamp (a large number), never to be confused with mesid.
 * A mesid is a valid index into chat, hence the 0 <= mesId < chat.length
 * guard — anything else is already a stable key.
 * @param {Record<string, any>} collapsedMessages
 * @param {any[]} chat
 * @param {string} chatId
 * @returns {boolean}
 */
export function migratePositionalKeysIfNeeded(collapsedMessages, chat, chatId) {
    const map = collapsedMessages?.[chatId];
    if (!map || !chat) return false;

    const isPositionalKey = (key) => {
        const mesId = parseInt(key);
        return !isNaN(mesId) && mesId >= 0 && mesId < chat.length;
    };

    let needsMigration = false;
    for (const key in map) {
        if (isPositionalKey(key)) { needsMigration = true; break; }
    }
    if (!needsMigration) return false;

    const newMap = {};
    for (const key in map) {
        if (isPositionalKey(key)) {
            const mesId = parseInt(key);
            if (chat[mesId]?.send_date) {
                newMap[String(chat[mesId].send_date)] = true;
            }
        } else {
            newMap[key] = true;
        }
    }
    collapsedMessages[chatId] = newMap;
    return true;
}
