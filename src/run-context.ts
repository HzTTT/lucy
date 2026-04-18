import { AsyncLocalStorage } from "node:async_hooks";

export type LucyRunContext = {
  sourceMessageId: string;
  cuk: string;
  cdi: string;
  sessionKey?: string;
  runIdRef: { current?: string };
};

const lucyRunContextStore = new AsyncLocalStorage<LucyRunContext>();

export function runInLucyInboundContext<T>(
  ctx: LucyRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  return lucyRunContextStore.run(ctx, fn);
}

export function getLucyInboundContext(): LucyRunContext | undefined {
  return lucyRunContextStore.getStore();
}
