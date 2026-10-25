import { getDefaultConfig } from 'connectkit'
import { defineChain } from 'viem'
import { createConfig } from 'wagmi'

export const somniaTestnet = defineChain({
  id: 50383,
  name: 'Somnia Testnet',
  nativeCurrency: {
    name: 'Somnia Testnet Token',
    symbol: 'STT',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [import.meta.env.VITE_SOMNIA_RPC_URL ?? 'https://dream-rpc.somnia.network'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Somnia Explorer',
      url: import.meta.env.VITE_SOMNIA_EXPLORER_URL ?? 'https://explorer.somnia.network',
    },
  },
  testnet: true,
})

export const walletConfig = createConfig(getDefaultConfig({
  appName: 'Dexter',
  appDescription: 'A deliberate risk-control layer for perps trading.',
  appUrl: import.meta.env.VITE_APP_URL ?? window.location.origin,
  appIcon: `${import.meta.env.VITE_APP_URL ?? window.location.origin}/logo.png`,
  walletConnectProjectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '',
  chains: [somniaTestnet],
}))
