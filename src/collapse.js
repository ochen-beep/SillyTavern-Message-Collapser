// @ts-check
/**
 * Message Collapser — Collapse runtime.
 * Per-message DOM: arrow injection, collapsed-state application (the single
 * write point), the decision pipeline (hidden-from-prompt > manual collapsed
 * > manual expanded > auto rules), the chat MutationObserver, and the chat
 * lifecycle handlers (CHAT_CHANGED / CHAT_DELETED).
 */

import { arrowClass, collapsedClass, previewClass, eventNamespace, getSettings, getCtx, saveSettings, trace } from './core.js';
import {
    getStableMessageKey as getStableMessageKeyFromState,
    isManuallyCollapsed as isManuallyCollapsedFromState,
    isManuallyExpanded as isManuallyExpandedFromState,
    saveManualToggleState as saveManualToggleStateToState,
    migratePositionalKeysIfNeeded as migratePositionalKeysInPlace,
} from './state.js';
import { tr } from './i18n.js';

// ── Settings / key helpers ──

function getCurrentChatId() {
    return getCtx().chatId ?? null;
}

// Stable message key. mesid is a position in the chat array and drifts on
// deletion/reordering: removing message #3 silently shifts every collapsed
// flag below it. send_date is a timestamp ST stamps on message birth
// (getMessageTimeStamp) and never changes afterwards; unique within a chat.
// When send_date is unexpectedly missing, return null and DO NOT persist —
// visual effect only for the current session, no garbage in settings.
function getStableMessageKey(mesElement) {
    return getStableMessageKeyFromState(getCtx().chat, mesElement);
}

function isManuallyCollapsed(chatId, key) {
    return isManuallyCollapsedFromState(getSettings()?.collapsedMessages, chatId, key);
}

function isManuallyExpanded(chatId, key) {
    return isManuallyExpandedFromState(getSettings()?.manuallyExpandedMessages, chatId, key);
}

// Persist the manual collapsed/expanded state of one message. Collapse drops
// the key from manuallyExpandedMessages and expand from collapsedMessages, so
// a manual choice always overrides auto-collapse.
function saveManualToggleState(chatId, key, collapsed) {
    const changed = saveManualToggleStateToState(getSettings(), chatId, key, collapsed);
    if (changed) saveSettings();
}

// ── DOM primitives ──

// ST filters messages by chat[mesId].is_system and mirrors it into the .mes
// attribute in hideChatMessageRange (see .mes:not([is_system="true"]) in
// script.js). A direct getAttribute is the cheap (no reflow) source of truth.
export function isMessageHiddenFromPrompt(mesElement) {
    return mesElement.getAttribute('is_system') === 'true';
}

// Idempotently add the arrow button to a message's action bar. The extension
// class is unique, so .find() is safe and covers both placements (inside
// .mes_buttons or directly under .mes). role/tabindex/aria enable keyboard
// activation (see handleArrowKeydown).
export function ensureArrow($message) {
    let $arrow = $message.find('.' + arrowClass).first();
    if ($arrow.length === 0) {
        $arrow = $(`<div class="mes_button ${arrowClass}" role="button" tabindex="0" aria-expanded="true" title="${tr('Collapse or expand this message', 'mc.arrow.title')}"><i class="fas fa-chevron-up"></i></div>`);
        const $buttons = $message.find('.mes_buttons');
        ($buttons.length ? $buttons : $message).prepend($arrow);
    }
    return $arrow;
}

// Apply the collapsed state via class + icon + ARIA. Single write point.
// fa-chevron-up = expanded ("collapse"), fa-chevron-down = collapsed ("expand").
// With preview mode on, collapsed messages show the first N lines.
export function applyCollapsedState($message, $arrow, collapsed) {
    const usePreview = collapsed && getSettings().previewMode === 'preview';
    $message.toggleClass(collapsedClass, collapsed);
    $message.toggleClass(previewClass, usePreview);
    if ($arrow.length) {
        $arrow.attr('aria-expanded', collapsed ? 'false' : 'true')
              .find('i').toggleClass('fa-chevron-up', !collapsed)
                        .toggleClass('fa-chevron-down', collapsed);
    }
}

// ── Decision pipeline ──

// Auto-collapse by message length and/or age (distance from the chat end).
// Never persisted — recomputed on every render.
function shouldAutoCollapse(mesElement) {
    const settings = getSettings();
    if (!settings.autoCollapseByLength && !settings.autoCollapseByAge) return false;

    const mesId = parseInt(mesElement.getAttribute('mesid'));
    if (isNaN(mesId)) return false;
    const message = getCtx().chat?.[mesId];
    if (!message) return false;

    if (settings.autoCollapseByLength && message.mes && message.mes.length >= settings.lengthThreshold) {
        return true;
    }

    if (settings.autoCollapseByAge) {
        const chat = getCtx().chat;
        if (chat && chat.length - mesId - 1 >= settings.ageThreshold) {
            return true;
        }
    }

    return false;
}

// Decision for a single message. Priority:
// 1. Messages excluded from the prompt (is_system) — collapsed while the
//    auto-hidden rule is on (the eye icon governs; manual states are ignored).
//    With the rule off they are fully manual: only a persisted manual collapse
//    applies, and even the length/age rules are skipped — hidden messages are
//    usually long, so the length rule would silently re-collapse them.
// 2. Manually collapsed — collapsed.
// 3. Manually expanded — expanded (overrides auto-collapse).
// 4. Auto-collapse rules.
function shouldCollapseMessage(mesElement, chatId) {
    const key = getStableMessageKey(mesElement);
    if (isMessageHiddenFromPrompt(mesElement)) {
        if (getSettings().autoCollapseHidden) return true;
        return !!chatId && isManuallyCollapsed(chatId, key);
    }
    if (!!chatId && isManuallyCollapsed(chatId, key)) return true;
    if (!!chatId && isManuallyExpanded(chatId, key)) return false;
    return shouldAutoCollapse(mesElement);
}

function processMessages($messages, chatId) {
    $messages.each(function () {
        const $message = $(this);
        const $arrow = ensureArrow($message);
        applyCollapsedState($message, $arrow, shouldCollapseMessage(this, chatId));
    });
}

// ── Observer ──

// Adds arrows to freshly rendered messages (streaming, chat switch).
// Coalesces all addedNodes of a tick into one flush via queueMicrotask —
// a full chat rebuild is one batch, not N callbacks.
//
// NOTE: on a chat switch nodes arrive both via the MutationObserver and are
// processed synchronously in onChatChanged(). onChatChanged resets the
// pending set, otherwise the same nodes would run through _flushNewNodes a
// second time (double work on long chats). The Set deduplicates nodes that
// arrive in several mutations.

let _collapserObserver = null;
let _pendingNewNodes = new Set();
let _flushScheduled = false;

function _flushNewNodes() {
    _flushScheduled = false;
    if (_pendingNewNodes.size === 0) return;
    const nodes = _pendingNewNodes;
    _pendingNewNodes = new Set();
    const chatId = getCurrentChatId();
    for (const node of nodes) {
        const $message = $(node);
        const $arrow = ensureArrow($message);
        applyCollapsedState($message, $arrow, shouldCollapseMessage(node, chatId));
    }
}

export function startObserver() {
    if (_collapserObserver) return;
    const chat = document.getElementById('chat');
    if (!chat) return;
    _collapserObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === 1 && node.classList && node.classList.contains('mes')) {
                    _pendingNewNodes.add(node);
                }
            }
        }
        if (_pendingNewNodes.size > 0 && !_flushScheduled) {
            _flushScheduled = true;
            queueMicrotask(_flushNewNodes);
        }
    });
    _collapserObserver.observe(chat, { childList: true });
}

function stopObserver() {
    if (_collapserObserver) {
        _collapserObserver.disconnect();
        _collapserObserver = null;
    }
    _pendingNewNodes = new Set();
    _flushScheduled = false;
}

// ── Toggle / handlers ──

function toggleMessage($message) {
    const $arrow = $message.find('.' + arrowClass).first();
    const isCollapsed = $message.hasClass(collapsedClass);
    const nowCollapsed = !isCollapsed;
    applyCollapsedState($message, $arrow, nowCollapsed);

    const key = getStableMessageKey($message[0]);
    const chatId = getCurrentChatId();
    if (key && chatId) {
        saveManualToggleState(chatId, key, nowCollapsed);
    }
}

/** Delegated click handler: the target may be the inner <i>, so climb from the closest arrow to the message. */
export function handleArrowClick(event) {
    const $arrow = $(event.target).closest('.' + arrowClass);
    const $message = $arrow.closest('.mes');
    if ($message.length) toggleMessage($message);
}

// Keyboard activation of the arrow (Enter/Space) — accessibility for role=button.
export function handleArrowKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const $arrow = $(event.target).closest('.' + arrowClass);
    if (!$arrow.length) return;
    event.preventDefault();
    const $message = $arrow.closest('.mes');
    if ($message.length) toggleMessage($message);
}

/** Toggle a specific message by mesid. Used by /mc-toggle. */
export function toggleMessageByMesId(mesId) {
    const $message = $(`.mes[mesid="${mesId}"]`);
    if ($message.length === 0) {
        toastr.warning(tr('Message with mesid {mesId} not found.', 'mc.toast.messageNotFound', { mesId }));
        return;
    }
    toggleMessage($message);
}

// ── Chat lifecycle ──

// Chat loaded/switched (ST CHAT_CHANGED). One pass over .mes inserts arrows
// and applies the initial state: prompt-excluded and manually collapsed
// messages collapsed, everything else expanded.
export function onChatChanged() {
    if (!getSettings()?.isEnabled) return;
    const chatId = getCurrentChatId();
    if (chatId) {
        // mesid → send_date can only be resolved with the chat loaded, so the
        // lazy migration runs here. Fires once per chat: converted keys stop
        // being "numeric".
        const changed = migratePositionalKeysInPlace(
            getSettings()?.collapsedMessages,
            getCtx().chat,
            chatId,
        );
        if (changed) saveSettings();
    }

    // The synchronous pass already covers every current .mes; drop the
    // observer queue or the same nodes would flush a second time.
    _pendingNewNodes = new Set();
    _flushScheduled = false;

    processMessages($('.mes'), chatId);
}

// Chat deleted (ST CHAT_DELETED). Drop the saved collapse state of the
// deleted chat so collapsedMessages doesn't grow forever. ST passes the chat
// file name without .jsonl — the same key we persist under
// (characters[chatId].chat / getCurrentChatId()).
export function onChatDeleted(chatId) {
    const settings = getSettings();
    if (!chatId) return;
    let changed = false;
    if (settings?.collapsedMessages?.[chatId]) {
        delete settings.collapsedMessages[chatId];
        changed = true;
    }
    if (settings?.manuallyExpandedMessages?.[chatId]) {
        delete settings.manuallyExpandedMessages[chatId];
        changed = true;
    }
    if (changed) {
        saveSettings();
        trace(`onChatDeleted: dropped collapse state for "${chatId}"`);
    }
}

// ── Teardown ──

// Delegated document handlers for the collapse arrows (click + keyboard).
// Idempotent: .off(ns) before .on(ns). Called from init and again on every
// master-toggle re-enable — destroy() wipes them via $(document).off(ns),
// so binding only at init would leave arrow clicks dead after off→on.
export function bindArrowHandlers() {
    $(document).off('click' + eventNamespace, '.' + arrowClass)
               .on('click' + eventNamespace, '.' + arrowClass, handleArrowClick);
    $(document).off('keydown' + eventNamespace, '.' + arrowClass)
               .on('keydown' + eventNamespace, '.' + arrowClass, handleArrowKeydown);
}

// Removing the extension: strip arrows and expand everything. Collapsed state
// is carried by the CSS class only (no inline display styles), so removing
// the class is enough.
function removeCollapseArrowsFromMessages() {
    $('.' + collapsedClass).removeClass(collapsedClass);
    $('.' + arrowClass).remove();
    stopObserver();
}

// Single cleanup point: observer, arrows, delegated document handlers. Used
// by onDisable and by the master toggle.
export function destroy() {
    removeCollapseArrowsFromMessages();
    $(document).off(eventNamespace);
}
