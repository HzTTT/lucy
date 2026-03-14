import qrcode from "qrcode-terminal";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildLucyAuthQrUri } from "./auth-qrcode.js";
import { loadOrCreateLucyDeviceState } from "./state.js";

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
    "Generate a QR code that contains the current channel_device_id so the iOS app can scan and bind it.",
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

export function registerLucyCommand(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }) => {
      const lucy = program.command("lucy").description("Lucy helper commands.");

      lucy
        .command("auth-qrcode")
        .description("Print a QR code that contains the current channel_device_id for app binding.")
        .action(async () => {
          const state = await loadOrCreateLucyDeviceState();
          const qrUrl = buildLucyBindQrUrl(state.channelDeviceId);
          const qrAscii = await renderQrAscii(qrUrl);
          printLucyAuthQrToConsole({
            channelDeviceId: state.channelDeviceId,
            qrUrl,
            qrAscii,
          });
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
      const action = args.split(/\s+/, 1)[0]?.toLowerCase() ?? "";

      if (!action || action === "help") {
        return { text: formatLucyCommandHelp() };
      }

      if (action !== "auth-qrcode") {
        return { text: formatLucyCommandHelp() };
      }

      const state = await loadOrCreateLucyDeviceState();
      const qrUrl = buildLucyBindQrUrl(state.channelDeviceId);
      const qrAscii = await renderQrAscii(qrUrl);
      return {
        text: formatLucyAuthQrReply({
          channelDeviceId: state.channelDeviceId,
          qrUrl,
          qrAscii,
        }),
      };
    },
  });
}
