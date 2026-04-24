import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { imessageQuietPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(imessageQuietPlugin);
