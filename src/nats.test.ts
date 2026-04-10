import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { serializeLucyMachineEventJson, buildNpcSubscribeSubject, buildNpcPublishSubject } from "./nats.js";
import type { LucyMachineEvent } from "./types.js";

describe("lucy nats transport", () => {
  it("encodes machine events with protocol field names from the auth-binding docs", () => {
    const event: LucyMachineEvent = {
      version: 2,
      eventId: "2031409944885334016",
      type: "assistant.final",
      timestamp: 1773160847289,
      channelUserKey: "cuk_demo_user",
      channelDeviceId: "2031378112080429056",
      sourceMessageId: "1773160841833000000",
      runId: "90366a44-cd81-4ff4-a10e-87a931c3e740",
      sessionKey: "agent:main:main",
      text: "hello",
      toolName: "read",
      metadata: { platform: "ios" },
    };

    expect(JSON.parse(serializeLucyMachineEventJson(event))).toEqual({
      version: 2,
      eventId: "2031409944885334016",
      type: "assistant.final",
      timestamp: 1773160847289,
      channel_user_key: "cuk_demo_user",
      channel_device_id: "2031378112080429056",
      source_message_id: "1773160841833000000",
      run_id: "90366a44-cd81-4ff4-a10e-87a931c3e740",
      session_key: "agent:main:main",
      text: "hello",
      tool_name: "read",
      metadata: { platform: "ios" },
    });
  });

  it("encodes approval events with approval metadata fields", () => {
    const event: LucyMachineEvent = {
      version: 2,
      eventId: "2031409944885334017",
      type: "approval.pending",
      timestamp: 1773160847290,
      channelUserKey: "cuk_demo_user",
      channelDeviceId: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approvalSlug: "apv_abc1",
      approvalCommand: "mkdir -p /home/lucy/data",
      approvalCwd: "/home/lucy",
      approvalHost: "gateway",
      approvalExpiresAtMs: 1773160900000,
      approvalAllowedDecisions: ["allow-once", "allow-always", "deny"],
    };

    expect(JSON.parse(serializeLucyMachineEventJson(event))).toEqual({
      version: 2,
      eventId: "2031409944885334017",
      type: "approval.pending",
      timestamp: 1773160847290,
      channel_user_key: "cuk_demo_user",
      channel_device_id: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approval_id: "apv_abc123def456",
      approvalSlug: "apv_abc1",
      approval_slug: "apv_abc1",
      approvalCommand: "mkdir -p /home/lucy/data",
      approval_command: "mkdir -p /home/lucy/data",
      approvalCwd: "/home/lucy",
      approval_cwd: "/home/lucy",
      approvalHost: "gateway",
      approval_host: "gateway",
      approvalExpiresAtMs: 1773160900000,
      approval_expires_at_ms: 1773160900000,
      approvalAllowedDecisions: ["allow-once", "allow-always", "deny"],
      approval_allowed_decisions: ["allow-once", "allow-always", "deny"],
    });
  });

  it("encodes approval resolution fields", () => {
    const event: LucyMachineEvent = {
      version: 2,
      eventId: "2031409944885334018",
      type: "approval.resolved",
      timestamp: 1773160847291,
      channelUserKey: "cuk_demo_user",
      channelDeviceId: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approvalDecision: "allow-always",
      approvalResolvedBy: "cuk_demo_user",
    };

    expect(JSON.parse(serializeLucyMachineEventJson(event))).toEqual({
      version: 2,
      eventId: "2031409944885334018",
      type: "approval.resolved",
      timestamp: 1773160847291,
      channel_user_key: "cuk_demo_user",
      channel_device_id: "2031378112080429056",
      approvalId: "apv_abc123def456",
      approval_id: "apv_abc123def456",
      approvalDecision: "allow-always",
      approval_decision: "allow-always",
      approvalResolvedBy: "cuk_demo_user",
      approval_resolved_by: "cuk_demo_user",
    });
  });

  it("builds subscribe subject from userId and cdi", () => {
    expect(buildNpcSubscribeSubject("user_demo", "2031378112080429056")).toBe(
      "cephalon.im.npc.user_demo.2031378112080429056",
    );
  });

  it("builds publish subject from userId", () => {
    expect(buildNpcPublishSubject("user_demo")).toBe("cephalon.im.user.user_demo");
  });
});

// Ensure Buffer is used so the import isn't flagged as unused
void Buffer;
