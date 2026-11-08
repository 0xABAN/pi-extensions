import { DEFAULT_COLLAPSE_KEY, DEFAULT_NOTES_KEY } from "../config.ts";

/** Leaf: imports nothing from `view/`, so `dialog-builder` and `tab-content-strategy` never form a runtime cycle (#208). */

export const HINT_PART_NEW_LINE = "shift+enter for newline";
export const HINT_PART_CLEAR = "ctrl+u to clear";
export const HINT_PART_TOGGLE = "space to toggle";
export const HINT_PART_TAB = "tab to switch questions";
export const HINT_PART_CANCEL = "esc to cancel";
/**
 * Collapse/expand hint copy is templated on `KEY_PLACEHOLDER` because the
 * shortcut is configurable (`collapseKey`) and `rpiv-i18n`'s `tr` has no
 * interpolation — locale entries carry the same `{key}` placeholder and call
 * sites `.replace()` it with the configured key after
 * lookup, so per-locale word order is preserved.
 */
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} to collapse`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} to expand`;
/** Notes hint, templated the same way on the configurable `notesKey`. */
export const HINT_PART_NOTES_TEMPLATE = `${KEY_PLACEHOLDER} to add notes`;
/** Default-key (`n`) rendering of the notes template. */
export const HINT_PART_NOTES = HINT_PART_NOTES_TEMPLATE.replace(KEY_PLACEHOLDER, DEFAULT_NOTES_KEY);
/** Default-key (`ctrl+]`) rendering of the collapse template, for tests and default-config assertions. */
export const HINT_PART_COLLAPSE = HINT_PART_COLLAPSE_TEMPLATE.replace(KEY_PLACEHOLDER, DEFAULT_COLLAPSE_KEY);
/**
 * Template for the single-line footer shown by `QuestionnaireSession` when
 * `state.collapsed === true`. Bypasses `buildHintText`; the session replaces
 * `KEY_PLACEHOLDER` with the configured key's display form.
 */
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";
