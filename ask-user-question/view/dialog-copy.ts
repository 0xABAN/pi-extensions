import { DEFAULT_COLLAPSE_KEY, DEFAULT_NOTES_KEY } from "../config.ts";

export const HINT_PART_NEW_LINE = "shift+enter for newline";
export const HINT_PART_CLEAR = "ctrl+u to clear";
export const HINT_PART_TOGGLE = "space to toggle";
export const HINT_PART_TAB = "tab to switch questions";
export const HINT_PART_CANCEL = "esc to cancel";
export const KEY_PLACEHOLDER = "{key}";
export const HINT_PART_COLLAPSE_TEMPLATE = `${KEY_PLACEHOLDER} to collapse`;
export const HINT_PART_EXPAND_TEMPLATE = `${KEY_PLACEHOLDER} to expand`;
export const HINT_PART_NOTES_TEMPLATE = `${KEY_PLACEHOLDER} to add notes`;
export const HINT_PART_NOTES = HINT_PART_NOTES_TEMPLATE.replace(KEY_PLACEHOLDER, DEFAULT_NOTES_KEY);
export const HINT_PART_COLLAPSE = HINT_PART_COLLAPSE_TEMPLATE.replace(KEY_PLACEHOLDER, DEFAULT_COLLAPSE_KEY);
export const COLLAPSED_HINT_TEMPLATE = [HINT_PART_EXPAND_TEMPLATE, HINT_PART_CANCEL].join(" · ");
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";
