import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { imessageQuietPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "imessage-quiet",
  name: "iMessage (Quiet)",
  description: "Mention-gated iMessage channel — speak when spoken to",
  plugin: imessageQuietPlugin,
});
