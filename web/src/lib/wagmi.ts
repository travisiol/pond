import { createConfig, http, injected } from "wagmi";
import { robinhoodChain } from "@/lib/chain";

export const wagmiConfig = createConfig({
  chains: [robinhoodChain],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: {
    [robinhoodChain.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
