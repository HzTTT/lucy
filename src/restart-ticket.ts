import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getLucyRuntime } from "./runtime.js";

export const LucyRestartTicketSchema = z.object({
  version: z.literal(1),
  ticketId: z.string().min(1),
  requestedAtMs: z.number().int().nonnegative(),
  expectedOnlineAtMs: z.number().int().nonnegative(),
  expectedOnlineTimeoutMs: z.number().int().positive(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

export type LucyRestartTicket = z.infer<typeof LucyRestartTicketSchema>;

export function resolveLucyRestartTicketPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = getLucyRuntime().state.resolveStateDir(env, os.homedir);
  return path.join(stateDir, "lucy", "restart-ticket.json");
}

export async function readLucyRestartTicket(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<LucyRestartTicket | null> {
  const filePath = resolveLucyRestartTicketPath(params?.env);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return LucyRestartTicketSchema.parse(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

export async function writeLucyRestartTicket(
  ticket: LucyRestartTicket,
  params?: { env?: NodeJS.ProcessEnv },
): Promise<void> {
  const filePath = resolveLucyRestartTicketPath(params?.env);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath, `${JSON.stringify(ticket, null, 2)}\n`, "utf8");
  await fs.chmod(filePath, 0o600);
}

export async function clearLucyRestartTicket(params?: {
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const filePath = resolveLucyRestartTicketPath(params?.env);
  try {
    await fs.unlink(filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }
}
