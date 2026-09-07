// GenLayer wiring. Reads need no wallet; only `rule` does.
//
// The split matters for the product. Anybody can open this page and see the
// whole answer key and every ruling behind it, because that is public state on
// a public chain. A wallet is only ever asked for when someone wants to change
// that state, which happens exactly once per novel phrasing.

import { createClient } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus, type CalldataEncodable } from "genlayer-js/types";
import { rawProvider } from "./wallet";

export const CONTRACT = "0x4C95B77f8D6CF7F3EC412aAaB6EFed5b92343FD3";
export const EXPLORER = `https://explorer-bradbury.genlayer.com/address/${CONTRACT}`;

/** Read only. No account, so no wallet prompt and no chain switch. */
function readClient() {
  return createClient({ chain: testnetBradbury });
}

function writeClient(account: string) {
  return createClient({
    chain: testnetBradbury,
    account: account as never,
    provider: rawProvider() as never,
  });
}

/**
 * Bradbury rate limits, routinely and hard, and a burst of view calls on page
 * load is exactly the shape it pushes back on. A rejected read is retried with
 * a growing pause; anything that is not a rate limit is rethrown immediately,
 * because retrying a genuine contract error just delays the message.
 */
function isRateLimit(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /rate limit|exceeds defined limit|429|too many requests/i.test(text);
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function read<T>(
  functionName: string,
  args: CalldataEncodable[] = [],
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const raw = await readClient().readContract({
        address: CONTRACT as never,
        functionName,
        args,
      });
      return raw as T;
    } catch (err) {
      lastError = err;
      if (!isRateLimit(err)) throw err;
      await wait(600 * 2 ** attempt);
    }
  }
  throw lastError;
}

/**
 * Runs the tasks a few at a time instead of all at once. Ten questions fired in
 * one `Promise.all` is a burst the node answers with a rate limit often enough
 * to matter, and the whole page load then fails on the retry budget. Three at a
 * time is barely slower and is what stopped it.
 */
async function inWaves<T>(
  tasks: (() => Promise<T>)[],
  width = 3,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < tasks.length; i += width) {
    out.push(...(await Promise.all(tasks.slice(i, i + width).map((t) => t()))));
  }
  return out;
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
  /** The address that paid for the round. Lets a visitor find their own. */
  asked_by: string;
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
  const rows = await inWaves(
    ids.map((id) => async () => {
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

/**
 * The feed, enriched with who paid for each round.
 *
 * `recent_rulings` returns the verdict and the reason but not the asker, while
 * `get_ruling` returns all three for one row. Both read the same stored record,
 * so the address is already on chain and nothing here invents it. Fetching it
 * per row costs a handful of extra view calls and avoids redeploying purely to
 * widen one serialiser, which would have cost the live ruling history and left
 * the source in this repo no longer matching the deployed contract.
 *
 * A row whose lookup fails keeps its verdict and reason and simply loses the
 * attribution line, because a missing byline is a far better outcome than a
 * feed that refuses to render.
 */
export async function loadRulings(limit = 12): Promise<RulingRow[]> {
  const rows = JSON.parse(
    await read<string>("recent_rulings", [limit]),
  ) as RulingRow[];
  return inWaves(
    rows.map((row) => async () => {
      try {
        const full = JSON.parse(
          await read<string>("get_ruling", [row.question_id, row.answer]),
        ) as { asked_by?: string };
        return { ...row, asked_by: full.asked_by ?? "" };
      } catch {
        return { ...row, asked_by: "" };
      }
    }),
  );
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
