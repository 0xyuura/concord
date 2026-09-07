// The wallet layer.
//
// Reads never touch this file. That is deliberate and it is the reason the page
// is worth opening at all: the answer key is public state, so anyone can audit
// it without owning anything. A wallet is asked for at exactly one moment, when
// somebody wants to change that state.
//
// Discovery is the part that was wrong before. Reading `window.ethereum` once,
// during render, misses two very common cases: an extension that injects a
// moment after first paint, and a wallet that follows EIP-6963 and announces
// itself on an event instead of squatting on a global. Either one left the page
// insisting there was no wallet on a machine that plainly had one. So discovery
// here is a subscription, not a question asked once.

export const CHAIN_ID = 4221;
export const CHAIN_ID_HEX = "0x107d";
export const RPC_URL = "https://rpc-bradbury.genlayer.com";
export const EXPLORER_ROOT = "https://explorer-bradbury.genlayer.com";
export const FAUCET_URL = "https://faucet.genlayer.com/";

type Handler = (payload: never) => void;

export interface Eip1193 {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: Handler) => void;
  removeListener?: (event: string, handler: Handler) => void;
  isMetaMask?: boolean;
}

/** One wallet the browser is offering, however it announced itself. */
export interface WalletOption {
  /** Stable key. The EIP-6963 uuid when there is one, else a derived id. */
  id: string;
  name: string;
  /** data: URI the wallet supplies. Absent for a bare window.ethereum. */
  icon?: string;
  provider: Eip1193;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: Eip1193;
}

function legacyProvider(): Eip1193 | undefined {
  return (window as { ethereum?: Eip1193 }).ethereum;
}

function legacyName(provider: Eip1193): string {
  return provider.isMetaMask ? "MetaMask" : "Injected wallet";
}

/**
 * Watches for wallets and calls back every time the set changes.
 *
 * Three sources, because no single one is reliable:
 *   1. EIP-6963 announcements, which is how wallets are supposed to do it and
 *      the only way to see past the first extension when several are installed.
 *   2. `window.ethereum`, still the only thing some wallets set.
 *   3. `ethereum#initialized` plus a short poll, for the extension that arrives
 *      after React has already painted. The poll stops on its own; it is there
 *      to cover the first second of the page, not to run forever.
 *
 * Returns an unsubscribe.
 */
export function discoverWallets(onChange: (found: WalletOption[]) => void): () => void {
  if (typeof window === "undefined") return () => {};

  const byId = new Map<string, WalletOption>();

  const publish = () => onChange([...byId.values()]);

  const addLegacy = () => {
    const provider = legacyProvider();
    if (!provider) return false;
    // Skip when EIP-6963 already announced this exact provider object, or the
    // same wallet would be offered to the user twice.
    for (const option of byId.values()) {
      if (option.provider === provider) return false;
    }
    const id = "injected:" + legacyName(provider);
    if (byId.has(id)) return false;
    byId.set(id, { id, name: legacyName(provider), provider });
    return true;
  };

  const onAnnounce = ((event: CustomEvent<Eip6963Detail>) => {
    const { info, provider } = event.detail;
    if (byId.has(info.uuid)) return;
    // Drop a legacy entry that turns out to be this same provider, so a wallet
    // that both squats on the global and announces properly appears once.
    for (const [key, option] of byId) {
      if (option.provider === provider) byId.delete(key);
    }
    byId.set(info.uuid, {
      id: info.uuid,
      name: info.name,
      icon: info.icon,
      provider,
    });
    publish();
  }) as EventListener;

  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  if (addLegacy()) publish();

  const onInitialized = () => {
    if (addLegacy()) publish();
  };
  window.addEventListener("ethereum#initialized", onInitialized);

  // Covers the extension that lands a beat after first paint and fires nothing.
  let ticks = 0;
  const poll = window.setInterval(() => {
    ticks += 1;
    if (addLegacy()) publish();
    if (ticks >= 10 || byId.size) window.clearInterval(poll);
  }, 300);

  return () => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    window.removeEventListener("ethereum#initialized", onInitialized);
    window.clearInterval(poll);
  };
}

export function short(address: string): string {
  return address.slice(0, 6) + "..." + address.slice(-4);
}

/**
 * Accounts already authorised for this origin. No prompt, so it is safe to call
 * the moment a wallet is discovered: a returning visitor sees their wallet
 * connected without being asked again, and a first time visitor sees nothing.
 */
export async function silentAccount(provider: Eip1193): Promise<string> {
  try {
    const accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    return accounts?.[0] ?? "";
  } catch {
    return "";
  }
}

export async function connect(provider: Eip1193): Promise<string> {
  const accounts = (await provider.request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.length) throw new Error("The wallet returned no account.");
  return accounts[0];
}

/**
 * Best effort. Most wallets have no real disconnect, so the honest thing is to
 * drop the account this page holds and, where the wallet supports it, hand the
 * permission back so the next visit starts clean rather than silently
 * reconnecting.
 */
export async function disconnect(provider: Eip1193): Promise<void> {
  try {
    await provider.request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    // Wallet does not implement it. The page still forgets the account.
  }
}

export async function chainId(provider: Eip1193): Promise<number> {
  try {
    return Number(await provider.request({ method: "eth_chainId" }));
  } catch {
    return 0;
  }
}

/**
 * Move the wallet to Bradbury, adding the network first if it has never seen
 * it. 4902 is the "unrecognised chain" code; anything else is the user saying
 * no, which is left to the caller to report rather than swallowed.
 */
export async function switchToBradbury(provider: Eip1193): Promise<void> {
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: CHAIN_ID_HEX,
          chainName: "GenLayer Testnet Bradbury",
          nativeCurrency: { name: "GEN Token", symbol: "GEN", decimals: 18 },
          rpcUrls: [RPC_URL],
          blockExplorerUrls: [EXPLORER_ROOT],
        },
      ],
    });
  }
}

/** Balance in whole GEN, read straight from the node rather than the wallet. */
export async function balanceOf(address: string): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  const body = (await res.json()) as { result?: string; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return Number(BigInt(body.result ?? "0x0")) / 1e18;
}

export function formatGen(amount: number): string {
  if (amount === 0) return "0";
  if (amount < 0.0001) return "<0.0001";
  if (amount < 1) return amount.toFixed(4);
  if (amount < 1000) return amount.toFixed(3);
  return Math.round(amount).toLocaleString("en-US");
}

/**
 * Account and chain changes. Both matter: a user who switches to an account
 * with no GEN, or to a different network, would otherwise press a button that
 * cannot possibly work and get a raw provider error for it.
 */
export function watch(
  provider: Eip1193,
  handlers: { onAccount: (address: string) => void; onChain: (id: number) => void },
): () => void {
  if (!provider.on) return () => {};
  const accountHandler = ((accounts: string[]) => {
    handlers.onAccount(accounts?.[0] ?? "");
  }) as unknown as Handler;
  const chainHandler = ((id: string) => {
    handlers.onChain(Number(id));
  }) as unknown as Handler;
  provider.on("accountsChanged", accountHandler);
  provider.on("chainChanged", chainHandler);
  return () => {
    provider.removeListener?.("accountsChanged", accountHandler);
    provider.removeListener?.("chainChanged", chainHandler);
  };
}
