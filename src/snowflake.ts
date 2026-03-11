import crypto from "node:crypto";

const TWITTER_EPOCH_MS = 1_288_834_974_657n;
const WORKER_BITS = 10n;
const SEQUENCE_BITS = 12n;
const MAX_WORKER = (1 << Number(WORKER_BITS)) - 1;
const MAX_SEQUENCE = (1 << Number(SEQUENCE_BITS)) - 1;

export class SnowflakeGenerator {
  #lastTimestampMs = -1n;
  #sequence = 0n;
  readonly workerId: bigint;
  readonly now: () => number;

  constructor(workerId: number, now: () => number = Date.now) {
    if (!Number.isInteger(workerId) || workerId < 0 || workerId > MAX_WORKER) {
      throw new Error(`workerId must be an integer between 0 and ${String(MAX_WORKER)}`);
    }
    this.workerId = BigInt(workerId);
    this.now = now;
  }

  nextId(): string {
    let timestampMs = BigInt(this.now());
    if (timestampMs < this.#lastTimestampMs) {
      timestampMs = this.#lastTimestampMs;
    }

    if (timestampMs === this.#lastTimestampMs) {
      this.#sequence += 1n;
      if (this.#sequence > BigInt(MAX_SEQUENCE)) {
        timestampMs = this.#lastTimestampMs + 1n;
        this.#sequence = 0n;
      }
    } else {
      this.#sequence = 0n;
    }

    this.#lastTimestampMs = timestampMs;
    const id =
      ((timestampMs - TWITTER_EPOCH_MS) << (WORKER_BITS + SEQUENCE_BITS)) |
      (this.workerId << SEQUENCE_BITS) |
      this.#sequence;
    const asString = id.toString();
    if (!/^\d{19}$/.test(asString)) {
      throw new Error(`snowflake id must be a 19-digit string, got ${asString}`);
    }
    return asString;
  }
}

let processGenerator: SnowflakeGenerator | null = null;

export function getProcessSnowflakeGenerator(now: () => number = Date.now): SnowflakeGenerator {
  if (!processGenerator) {
    processGenerator = new SnowflakeGenerator(crypto.randomInt(0, MAX_WORKER + 1), now);
  }
  return processGenerator;
}
