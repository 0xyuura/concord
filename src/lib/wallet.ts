// The wallet layer.
//
// Reads never touch this file. That is deliberate and it is the reason the page
// is worth opening at all: the answer key is public state, so anyone can audit
// it without owning anything. A wallet is asked for at exactly one moment, when
// somebody wants to change that state.
//
// What this module adds over a bare `eth_requestAccounts` is the boring part
// that decides whether the moment succeeds: knowing which chain the wallet is
// actually pointed at, being able to move it to Bradbury without the user
// hunting through settings, knowing whether they can pay for the round before
// they press the button, and surviving the user switching accounts in another
// tab.

export const CHAIN_ID = 4221;
export const CHAIN_ID_HEX = "0x107d";
export const RPC_URL = "https://rpc-bradbury.genlayer.com";
export const EXPLORER_ROOT = "https://explorer-bradbury.genlayer.com";
export const FAUCET_URL = "https://faucet.genlayer.com/";

type Handler = (payload: never) => void;

interface Eth {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: Handler) => void;
  removeListener?: (event: string, handler: Handler) => void;
  isMetaMask?: boolean;
}

export function hasWallet(): boolean {
  return typeof window !== "undefined" && Boolean((window as { ethereum?: Eth }).ethereum);
}

function eth(): Eth {
  const found = (window as { ethereum?: Eth }).ethereum;
  if (!found) throw new Error("No injected wallet found in this browser.");
  return found;
}

/** The wallet's own name for itself, for the label on the chip. */
export function walletLabel(): string {
  if (!hasWallet()) return "Wallet";
  return eth().isMetaMask ? "MetaMask" : "Wallet";
}

export function short(address: string): string {
  return address.slice(0, 6) + "..." + address.slice(-4);
}

/**
 * Accounts already authorised for this origin. No prompt, so it is safe to call
 * on mount: a returning visitor sees their wallet connected without being asked
 * again, and a first time visitor sees nothing happen at all.
 */
export async function silentAccount(): Promise<string> {
  if (!hasWallet()) return "";
  try {
    const accounts = (await eth().request({ method: "eth_accounts" })) as string[];
    return accounts?.[0] ?? "";
  } catch {
    return "";
  }
}

export async function connect(): Promise<string> {
  const accounts = (await eth().request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("The wallet returned no account.");
  return accounts[0];
}

/**
 * Best effort. Most wallets have no real disconnect, so the honest thing is to
 * drop the account this page holds and, where the wallet supports it, hand the
 * permission back so the next visit starts clean rather than silently
 * reconnecting.
 */
export async function disconnect(): Promise<void> {
  if (!hasWallet()) return;
  try {
    await eth().request({
      method: "wallet_revokePermissions",
      params: [{ eth_accounts: {} }],
    });
  } catch {
    // Wallet does not implement it. The page still forgets the account.
  }
}

export async function chainId(): Promise<number> {
  if (!hasWallet()) return 0;
  try {
    return Number(await eth().request({ method: "eth_chainId" }));
  } catch {
    return 0;
  }
}

/**
 * Move the wallet to Bradbury, adding the network first if it has never seen
 * it. 4902 is the "unrecognised chain" code; anything else is the user saying
 * no, which is left to the caller to report rather than swallowed.
 */
export async function switchToBradbury(): Promise<void> {
  try {
    await eth().request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_ID_HEX }],
    });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code !== 4902) throw err;
    await eth().request({
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
export function watch(handlers: {
  onAccount: (address: string) => void;
  onChain: (id: number) => void;
}): () => void {
  if (!hasWallet() || !eth().on) return () => {};
  const provider = eth();
  const accountHandler = ((accounts: string[]) => {
    handlers.onAccount(accounts?.[0] ?? "");
  }) as unknown as Handler;
  const chainHandler = ((id: string) => {
    handlers.onChain(Number(id));
  }) as unknown as Handler;
  provider.on?.("accountsChanged", accountHandler);
  provider.on?.("chainChanged", chainHandler);
  return () => {
    provider.removeListener?.("accountsChanged", accountHandler);
    provider.removeListener?.("chainChanged", chainHandler);
  };
}

/** The raw provider, for genlayer-js to sign through. */
export function rawProvider(): unknown {
  return eth();
}
