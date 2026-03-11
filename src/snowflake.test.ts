import { describe, expect, it } from "vitest";
import { SnowflakeGenerator } from "./snowflake.js";

describe("SnowflakeGenerator", () => {
  it("emits 19-digit decimal ids", () => {
    let now = 1_762_800_000_000;
    const generator = new SnowflakeGenerator(7, () => now);
    const first = generator.nextId();
    now += 1;
    const second = generator.nextId();
    expect(first).toMatch(/^\d{19}$/);
    expect(second).toMatch(/^\d{19}$/);
    expect(BigInt(second)).toBeGreaterThan(BigInt(first));
  });
});
