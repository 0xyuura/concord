// GenLayer wiring. Reads need no wallet; only `rule` does.
//
// The split matters for the product. Anybody can open this page and see the
// whole answer key and every ruling behind it, because that is public state on
// a public chain. A wallet is only ever asked for when someone wants to change
// that state, which happens exactly once per novel phrasing.

import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus, type CalldataEncodable } from "genlayer-js/types";

export const CONTRACT = "0x4C95B77f8D6CF7F3EC412aAaB6EFed5b92343FD3";
export const EXPLORER = `https://explorer-bradbury.genlayer.com/address/${CONTRACT}`;

type Eth = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

export function hasWallet(): boolean {
  return typeof window !== "undefined" && Boolean((window as { ethereum?: Eth }).ethereum);
}

function ethereum(): Eth {
  const eth = (window as { ethereum?: Eth }).ethereum;
  if (!eth) throw new Error("No injected wallet found.");
  return eth;
}

/** Read only. No account, so no wallet prompt and no chain switch. */
function readClient() {
  return createClient({ chain: testnetBradbury });
}

function writeClient(account: string) {
  return createClient({
    chain: testnetBradbury,
    account: account as never,
    provider: ethereum() as never,
  });
}

export async function connect(): Promise<string> {
  const accounts = (await ethereum().request({
    method: "eth_requestAccounts",
  })) as string[];
  if (!accounts?.length) throw new Error("Wallet returned no account.");
  return accounts[0];
}

async function read<T>(
  functionName: string,
  args: CalldataEncodable[] = [],
): Promise<T> {
  const raw = await readClient().readContract({
    address: CONTRACT as never,
    functionName,
    args,
  });
  return raw as T;
}

export interface QuestionRow {
  id: string;
  prompt: string;
  canonical: string;
  forms: string[];
  ruledCount: number;
}

export interface RulingRow {
  question_id: string;
  answer: string;
  verdict: boolean;
  reason: string;
}

/**
 * One call for every question's accepted forms, then one per question for the
 * prompt text. The forms are what the client grades against, so they are
 * fetched together and refreshed after every ruling.
 */
export async function loadQuestions(): Promise<QuestionRow[]> {
  const formsBlob = await read<string>("all_forms");
  const byId = JSON.parse(formsBlob) as Record<string, string[]>;
  const ids = Object.keys(byId).sort(
    (a, b) => Number(a.replace(/\D/g, "")) - Number(b.replace(/\D/g, "")),
  );
  const rows = await Promise.all(
    ids.map(async (id) => {
      const detail = JSON.parse(await read<string>("get_question", [id])) as {
        prompt: string;
        canonical: string;
        forms: string[];
        ruled_count: number;
      };
      return {
        id,
        prompt: detail.prompt,
        canonical: detail.canonical,
        forms: detail.forms,
        ruledCount: detail.ruled_count,
      };
    }),
  );
  return rows;
}

export async function loadRulings(limit = 12): Promise<RulingRow[]> {
  return JSON.parse(await read<string>("recent_rulings", [limit])) as RulingRow[];
}

export async function rulingCount(): Promise<number> {
  return Number(await read<number>("ruling_count"));
}

/**
 * The one write. Sends the phrasing to the validators and waits for the round
 * to be accepted, then the caller refetches so the key on screen is the key on
 * chain rather than an optimistic guess.
 */
export async function rule(
  account: string,
  questionId: string,
  answer: string,
): Promise<void> {
  const client = writeClient(account);
  const hash = await client.writeContract({
    address: CONTRACT as never,
    functionName: "rule",
    args: [questionId, answer],
    value: 0n,
  });
  // ACCEPTED rather than FINALIZED: the round has been decided and the state
  // written, which is the moment the key has actually changed. Waiting for
  // finality here would leave someone staring at a spinner long after their
  // answer was already in the key.
  await client.waitForTransactionReceipt({
    hash: hash as never,
    status: TransactionStatus.ACCEPTED,
    retries: 200,
    interval: 3000,
  });
}
