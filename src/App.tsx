/**
 * Demo page: the Set card against the local server (npm run server, proxied by Vite).
 * In Blackboard, replace demoServerApi with an implementation backed by its own services.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createGlobalStyle } from "styled-components";
import { demoServerApi } from "./api/client";
import { SetCard } from "./components/SetCard";
import { theme } from "./theme";

const queryClient = new QueryClient();

const Global = createGlobalStyle`
  html, body { margin: 0; background: ${theme.color.bg}; color: ${theme.color.text}; }
  body { min-height: 100dvh; display: flex; align-items: center; justify-content: center; padding: env(safe-area-inset-top) 8px env(safe-area-inset-bottom); }
  #root { width: 100%; display: flex; justify-content: center; } /* the card's flex parent */
  * { box-sizing: border-box; }
`;

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Global />
      <SetCard api={demoServerApi} symbol="BTCUSDT" onAlert={(e) => console.log("[alert]", e)} />
    </QueryClientProvider>
  );
}
