/**
 * Blackboard design tokens (read from blackboard.fi's public app), used by the Set card.
 * Blackboard can delete this file and point the card at its own theme: every component
 * reads colours, fonts and radii only from here.
 */
export const theme = {
  color: {
    bg: "#000000",
    bgRaised: "#0a0a0a",
    surface1: "#0f1112",
    surface2: "#171a1c",
    surface3: "#202427",
    text: "#f2f2f2",
    muted: "#a8a8a8",
    dim: "#6f7377",
    mint: "#9af4d9", // accent: primary action, In band
    success: "#4ade80", // Buy, profit
    negative: "#ff453a", // Sell, loss, liquidation
    blue: "#a6bbff", // Out band, info
    amber: "#f4b978", // warnings, fallbacks, trial mode
  },
  font: {
    ui: "'Figtree', system-ui, sans-serif",
    mono: "'IBM Plex Mono', ui-monospace, monospace", // every number
    display: "'Fraunces', Georgia, serif",
  },
  radius: { sm: "7px", md: "11px", lg: "16px", xl: "20px", pill: "999px" },
} as const;

export type Theme = typeof theme;
