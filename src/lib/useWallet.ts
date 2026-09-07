// One hook holding everything the page needs to know about the wallet, so the
// component tree asks a question instead of poking at a provider.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHAIN_ID,
  type Eip1193,
  type WalletOption,
  balanceOf,
  chainId,
  connect,
  discoverWallets,
  disconnect,
  silentAccount,
  switchToBradbury,
  watch,
} from "./wallet";

/** Enough GEN to pay for a consensus round with room to spare. */
export const GAS_FLOOR = 0.001;

export type WalletBusy = "" | "connect" | "disconnect" | "switch" | "balance";

export interface WalletState {
  /** Every wallet the browser has offered so far. Grows as they announce. */
  options: WalletOption[];
  chosen: WalletOption | null;
  account: string;
  network: number;
  balance: number | null;
  busy: WalletBusy;
  error: string;
  /** True once discovery has had its chance, so "none found" means something. */
  settled: boolean;
  wrongNetwork: boolean;
  /** Connected, on Bradbury, and able to pay. The one gate on sending. */
  ready: boolean;
  broke: boolean;
  provider: Eip1193 | null;
  connectTo: (option: WalletOption) => Promise<void>;
  leave: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  refreshBalance: () => Promise<void>;
  clearError: () => void;
}

export function useWallet(): WalletState {
  const [options, setOptions] = useState<WalletOption[]>([]);
  const [chosen, setChosen] = useState<WalletOption | null>(null);
  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState(0);
  const [balance, setBalance] = useState<number | null>(null);
  const [busy, setBusy] = useState<WalletBusy>("");
  const [error, setError] = useState("");
  const [settled, setSettled] = useState(false);

  // Discovery keeps running for the life of the page, because a wallet can be
  // unlocked or installed while the tab is open.
  useEffect(() => {
    const stop = discoverWallets(setOptions);
    // Discovery is a subscription with no completion, so "settled" is a timer:
    // long enough that a slow extension has announced, short enough that the
    // empty state is not a mystery.
    const settle = window.setTimeout(() => setSettled(true), 1200);
    return () => {
      stop();
      window.clearTimeout(settle);
    };
  }, []);

  const readBalance = useCallback(async (address: string) => {
    if (!address) {
      setBalance(null);
      return;
    }
    try {
      setBalance(await balanceOf(address));
    } catch {
      setBalance(null);
    }
  }, []);

  // Silent restore. Runs once against the first wallet that already has an
  // authorised account, so a returning visitor is connected without a prompt
  // and a first time visitor is not interrupted.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !options.length) return;
    restored.current = true;
    (async () => {
      for (const option of options) {
        const existing = await silentAccount(option.provider);
        if (!existing) continue;
        setChosen(option);
        setAccount(existing);
        setNetwork(await chainId(option.provider));
        void readBalance(existing);
        return;
      }
      restored.current = false; // nothing authorised yet; let a later wallet try
    })();
  }, [options, readBalance]);

  // Follow the wallet rather than assume it stands still.
  useEffect(() => {
    if (!chosen) return;
    return watch(chosen.provider, {
      onAccount: (address) => {
        setAccount(address);
        setError("");
        void readBalance(address);
      },
      onChain: (id) => setNetwork(id),
    });
  }, [chosen, readBalance]);

  const run = useCallback(async (kind: WalletBusy, fn: () => Promise<void>) => {
    setBusy(kind);
    setError("");
    try {
      await fn();
    } catch (err) {
      // Wallets report a user closing the prompt as an error. It is not one,
      // and reading it back as red text makes the page look broken.
      const code = (err as { code?: number })?.code;
      if (code === 4001) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  }, []);

  const connectTo = useCallback(
    (option: WalletOption) =>
      run("connect", async () => {
        const address = await connect(option.provider);
        setChosen(option);
        setAccount(address);
        setNetwork(await chainId(option.provider));
        await readBalance(address);
      }),
    [run, readBalance],
  );

  const leave = useCallback(
    () =>
      run("disconnect", async () => {
        if (chosen) await disconnect(chosen.provider);
        setAccount("");
        setBalance(null);
        setChosen(null);
        restored.current = true; // do not silently reconnect the wallet just dropped
      }),
    [run, chosen],
  );

  const switchNetwork = useCallback(
    () =>
      run("switch", async () => {
        if (!chosen) return;
        await switchToBradbury(chosen.provider);
        setNetwork(await chainId(chosen.provider));
        await readBalance(account);
      }),
    [run, chosen, account, readBalance],
  );

  const refreshBalance = useCallback(
    () => run("balance", () => readBalance(account)),
    [run, account, readBalance],
  );

  const wrongNetwork = Boolean(account) && network !== 0 && network !== CHAIN_ID;
  const broke = balance !== null && balance < GAS_FLOOR;

  return useMemo(
    () => ({
      options,
      chosen,
      account,
      network,
      balance,
      busy,
      error,
      settled,
      wrongNetwork,
      broke,
      ready: Boolean(account) && !wrongNetwork && !broke,
      provider: chosen?.provider ?? null,
      connectTo,
      leave,
      switchNetwork,
      refreshBalance,
      clearError: () => setError(""),
    }),
    [
      options,
      chosen,
      account,
      network,
      balance,
      busy,
      error,
      settled,
      wrongNetwork,
      broke,
      connectTo,
      leave,
      switchNetwork,
      refreshBalance,
    ],
  );
}
