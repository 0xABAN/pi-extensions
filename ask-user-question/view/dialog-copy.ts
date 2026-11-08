import { COLLAPSE_KEY, NOTES_KEY } from "../state/key-router.ts";

export const HINT_PART_NEW_LINE = "shift+enter for newline";
export const HINT_PART_CLEAR = "ctrl+u to clear";
export const HINT_PART_TOGGLE = "space to toggle";
export const HINT_PART_TAB = "tab to switch questions";
export const HINT_PART_CANCEL = "esc to cancel";
export const HINT_PART_NOTES = `${NOTES_KEY} to add notes`;
export const HINT_PART_COLLAPSE = `${COLLAPSE_KEY} to collapse`;
export const HINT_PART_REVIEW_NOTE = `${NOTES_KEY} to add a note`;
export const COLLAPSED_HINT = `${COLLAPSE_KEY} to expand · ${HINT_PART_CANCEL}`;
export const REVIEW_HEADING = "Review your answers";
export const READY_PROMPT = "Ready to submit your answers?";
export const INCOMPLETE_WARNING_PREFIX = "⚠ Answer remaining questions before submitting:";
