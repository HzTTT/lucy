import qrcode from "qrcode-terminal";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { LucyImClient } from "lucy-im-sdk";
import { buildLucyAuthQrUri } from "./auth-qrcode.js";
import { buildLucyImConfig, resolveLucyAccount } from "./config.js";

export function buildLucyBindQrUrl(channelDeviceId: string): string {
  return buildLucyAuthQrUri(channelDeviceId);
}

export function formatLucyAuthQrReply(params: {
  channelDeviceId: string;
  qrUrl: string;
  qrAscii: string;
}): string {
  return [
    "Lucy auth QR code generated.",
    "",
    "1) Open Lucy iOS Demo",
    "2) Sign in to user-center",
    "3) Scan this QR code to capture channel_device_id",
    "4) Confirm the bind action in the app",
    "",
    `channel_device_id: ${params.channelDeviceId}`,
    `bind_url: ${params.qrUrl}`,
    "",
    params.qrAscii.trimEnd(),
  ].join("\n");
}

export function formatLucyResetStateReply(params: {
  channelDeviceId: string;
  qrUrl: string;
  qrAscii: string;
}): string {
  return [
    "Lucy device state reset.",
    "",
    `new_channel_device_id: ${params.channelDeviceId}`,
    "new_binding_status: pending",
    "",
    "The previous Lucy binding was cleared.",
    "If Lucy gateway is running, reload or restart it before using the new device.",
    "",
    formatLucyAuthQrReply({
      channelDeviceId: params.channelDeviceId,
      qrUrl: params.qrUrl,
      qrAscii: params.qrAscii,
    }),
  ].join("\n");
}

function renderQrAscii(data: string): Promise<string> {
  return new Promise((resolve) => {
    qrcode.generate(data, { small: true }, (output: string) => {
      resolve(output);
    });
  });
}

function formatLucyCommandHelp(): string {
  return [
    "Lucy commands:",
    "",
    "openclaw lucy auth-qrcode",
    "/lucy auth-qrcode",
    "",
    "openclaw lucy reset-state",
    "openclaw lucy reset",
    "/lucy reset-state",
    "/lucy reset",
    "",
    "Generate a QR code that contains the current channel_device_id so the iOS app can scan and bind it.",
    "",
    "Reset the local Lucy device state, generate a fresh device identity, and print a new bind QR code.",
  ].join("\n");
}

function printLucyAuthQrToConsole(params: {
  channelDeviceId: string;
  qrUrl: string;
  qrAscii: string;
}) {
  console.log("Lucy auth QR code generated.");
  console.log("");
  console.log("1) Open Lucy iOS Demo");
  console.log("2) Sign in to user-center");
  console.log("3) Scan this QR code to capture channel_device_id");
  console.log("4) Confirm the bind action in the app");
  console.log("");
  console.log(`channel_device_id: ${params.channelDeviceId}`);
  console.log(`bind_url: ${params.qrUrl}`);
  console.log("");
  console.log(params.qrAscii.trimEnd());
}

async function buildLucyAuthQrPayload(channelDeviceId: string): Promise<{
  channelDeviceId: string;
  qrUrl: string;
  qrAscii: string;
}> {
  const qrUrl = buildLucyBindQrUrl(channelDeviceId);
  const qrAscii = await renderQrAscii(qrUrl);
  return {
    channelDeviceId,
    qrUrl,
    qrAscii,
  };
}

export function registerLucyCommand(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const lucy = program.command("lucy").description("Lucy helper commands.");

      lucy
        .command("auth-qrcode")
        .description("Print a QR code that contains the current channel_device_id for app binding.")
        .action(async () => {
          const account = resolveLucyAccount(api.runtime.config.loadConfig());
          const sdkCfg = buildLucyImConfig(account);
          const imClient = new LucyImClient(sdkCfg);
          const identity = await imClient.deviceIdentity();
          printLucyAuthQrToConsole(await buildLucyAuthQrPayload(identity.cdi));
        });

      lucy
        .command("reset-state")
        .alias("reset")
        .description(
          "Reset local Lucy device state, generate a new channel_device_id/bootstrap_token, and print a fresh bind QR code.",
        )
        .action(async () => {
          const account = resolveLucyAccount(api.runtime.config.loadConfig());
          const sdkCfg = buildLucyImConfig(account);
          const imClient = new LucyImClient(sdkCfg);
          await imClient.resetBinding();
          const identity = await imClient.deviceIdentity();
          const authQr = await buildLucyAuthQrPayload(identity.cdi);
          console.log(
            formatLucyResetStateReply({
              channelDeviceId: authQr.channelDeviceId,
              qrUrl: authQr.qrUrl,
              qrAscii: authQr.qrAscii,
            }),
          );
        });
    },
    { commands: ["lucy"] },
  );

  api.registerCommand({
    name: "lucy",
    description: "Lucy helper commands.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const args = ctx.args?.trim() ?? "";
      const tokens = args.split(/\s+/).filter(Boolean);
      const action = tokens[0]?.toLowerCase() ?? "";

      if (!action || action === "help") {
        return { text: formatLucyCommandHelp() };
      }

      if (action === "auth-qrcode") {
        const account = resolveLucyAccount(api.runtime.config.loadConfig());
        const sdkCfg = buildLucyImConfig(account);
        const imClient = new LucyImClient(sdkCfg);
        const identity = await imClient.deviceIdentity();
        const authQr = await buildLucyAuthQrPayload(identity.cdi);
        return {
          text: formatLucyAuthQrReply(authQr),
        };
      }

      if (action === "reset-state" || action === "reset") {
        const account = resolveLucyAccount(api.runtime.config.loadConfig());
        const sdkCfg = buildLucyImConfig(account);
        const imClient = new LucyImClient(sdkCfg);
        await imClient.resetBinding();
        const identity = await imClient.deviceIdentity();
        const authQr = await buildLucyAuthQrPayload(identity.cdi);
        return {
          text: formatLucyResetStateReply({
            channelDeviceId: authQr.channelDeviceId,
            qrUrl: authQr.qrUrl,
            qrAscii: authQr.qrAscii,
          }),
        };
      }

      return { text: formatLucyCommandHelp() };
    },
  });
}
