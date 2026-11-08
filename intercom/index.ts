import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { Connection } from "./connection.ts";
import { Inbound, type InboundEntry } from "./inbound.ts";
import { registerIntercomTool } from "./tool.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";

export default function intercom(pi: ExtensionAPI) {
  const connection = new Connection(pi, (client) => inbound.attach(client));
  const inbound = new Inbound(pi, connection);

  pi.on("session_start", (_event, ctx) => connection.start(ctx));

  pi.on("session_shutdown", async () => {
    inbound.stop();
    await connection.stop();
  });

  pi.on("session_info_changed", () => connection.syncPresence());
  pi.on("model_select", (event) => connection.setModel(event.model.id));

  pi.on("agent_start", () => {
    connection.agentStarted();
    inbound.flush();
  });
  pi.on("agent_end", () => connection.agentEnded());

  pi.on("turn_start", () => {
    inbound.replies.beginTurn();
    connection.syncPresence();
  });
  pi.on("turn_end", () => inbound.replies.endTurn());

  pi.on("tool_execution_start", (event) => connection.toolStarted(event.toolCallId, event.toolName));
  pi.on("tool_execution_end", (event) => connection.toolEnded(event.toolCallId));

  const expansion = new WeakMap<object, { globalExpanded: boolean; expanded: boolean }>();
  pi.registerMessageRenderer<InboundEntry>("intercom_message", (message, options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    let state = expansion.get(message);
    if (!state) {
      state = { globalExpanded: options.expanded, expanded: options.expanded };
      expansion.set(message, state);
    } else if (state.globalExpanded !== options.expanded) {
      state.globalExpanded = options.expanded;
      state.expanded = options.expanded;
    }
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText, !options.expanded, state, options.outputPad);
  });

  registerIntercomTool(pi, connection, inbound);
  registerCommands(pi, connection, inbound);
}
