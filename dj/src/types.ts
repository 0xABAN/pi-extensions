export type Layout = "minimal" | "medium" | "full";
export type Placement = "above" | "below";
export type Theme = { mode: "animated" | "solid"; colors: string[] };
export interface Settings {
  layout: Layout;
  placement: Placement;
  theme: Theme;
  customAnimated?: string[];
  customSolid?: string[];
}
export interface Track {
  name: string;
  artists: string;
  progressMs: number;
  durationMs: number;
}
export interface Playback {
  status: "playing" | "paused" | "idle" | "offline" | "auth";
  track?: Track;
  sampledAt: number;
  message?: string;
}
export const PASTELS = ["#FFF0F2", "#FFF5EB", "#FFFEEB", "#EFFDF3", "#EFF7FF", "#F6EFFF"];
export const DEFAULTS: Settings = {
  layout: "full",
  placement: "below",
  theme: { mode: "animated", colors: PASTELS },
};
