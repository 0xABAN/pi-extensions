export type Layout = "minimal" | "medium" | "full";
export type Placement = "above" | "below";
/** Validated colors are uppercase #RRGGBB: one for solid, at least two for animation. */
export type Theme = { mode: "animated" | "solid"; colors: string[] };

export interface Settings {
  layout: Layout;
  placement: Placement;
  theme: Theme;
  // Keep custom input when the user temporarily switches to a built-in palette.
  customAnimated?: string[];
  customSolid?: string[];
}

/** Spotify's last measured position and duration, both in milliseconds. */
export interface Track {
  name: string;
  artists: string;
  progressMs: number;
  durationMs: number;
}

/** A display snapshot; offline may retain a stale track, while auth can have none. */
export interface Playback {
  status: "playing" | "paused" | "idle" | "offline" | "auth";
  track?: Track;
  /** Local epoch milliseconds; extrapolate progress only while status is playing. */
  sampledAt: number;
  message?: string;
}

// Preserve the original Pi widget's six-color rainbow and ordering.
export const PASTELS = ["#FFF0F2", "#FFF5EB", "#FFFEEB", "#EFFDF3", "#EFF7FF", "#F6EFFF"];
export const DEFAULTS: Settings = {
  layout: "full",
  placement: "below",
  theme: { mode: "animated", colors: PASTELS },
};
