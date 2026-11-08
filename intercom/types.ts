export const EXTENSION_BUS_FEATURE = "extension-bus-v1";
export const EXACT_SEND_FEATURE = "exact-send-v1";
export const SESSION_HELD_ERROR_CODE = "E_SESSION_HELD";

export type DeliveryState = "socket_delivered" | "queued" | "failed" | "unknown";

export interface DeliveryDetails {
  delivery: DeliveryState;
  code?: string;
  retryable: boolean;
  outcomeKnown: boolean;
}

export type HerdrLocation =
  | {
      status: "current";
      workspace: { id: string; label: string };
      tab: { id: string; label: string };
      paneId: string;
      refreshedAt: number;
    }
  | { status: "not_hosted" }
  | {
      status: "unavailable";
      paneId: string;
      reason: "herdr_unavailable" | "unsupported" | "command_failed" | "pane_missing" | "invalid_response";
      detail?: string;
    };

export interface SessionInfo {
  id: string;
  endpointEpoch?: string;
  name?: string;
  runtimeFallbackAlias?: boolean;
  cwd: string;
  model: string;
  pid: number;
  startedAt: number;
  lastActivity: number;
  status?: string;
  peerUid?: number;
  trustedLocal?: boolean;
  contextPct?: number;
  contextTokens?: number;
  contextWindow?: number;
  tmuxPane?: string;
  herdrPaneId?: string;
  herdrLocation?: HerdrLocation;
}

export type SessionHolder = Pick<SessionInfo, "pid" | "cwd" | "name">;

export interface CrossMachineOrigin {
  name: string;
  sessionId: string;
  machine: string;
}

export interface CrossMachineProvenance {
  type: "ssh-relay";
  version: 1;
  origin: CrossMachineOrigin;
  trust: "ssh-asserted";
}

export interface Message {
  id: string;
  timestamp: number;
  senderSequence?: number;
  brokerReceivedAt?: number;
  brokerDeliveredAt?: number;
  receiverReceivedAt?: number;
  injectedAt?: number;
  supersedes?: string;
  retryOf?: string;
  replyTo?: string;
  expectsReply?: boolean;
  provenance?: MessageProvenance;
  crossMachine?: CrossMachineProvenance;
  content: {
    text: string;
    attachments?: Attachment[];
  };
}

export interface MessageProvenance {
  type: "extension_outbox";
  extensionId: string;
  extensionName: string;
  requestId: string;
}

export interface Attachment {
  type: "file" | "snippet" | "context";
  name: string;
  content: string;
  language?: string;
}

export type MessageReceiptStatus = "receiver_received" | "queued" | "injected" | "acknowledged" | "expired" | "cancelled" | "superseded" | "cancellation_requested";

export interface MessageReceipt {
  messageId: string;
  status: MessageReceiptStatus;
  timestamp: number;
  detail?: string;
}

export type MessageControlAction = "cancel" | "supersede";

export interface MessageControl {
  messageId: string;
  action: MessageControlAction;
  timestamp: number;
  supersededBy?: string;
  detail?: string;
}

export interface ExtensionCapability {
  namespace: string;
  ownerEligible: boolean;
}

export type SessionRegistration = Omit<SessionInfo, "id" | "endpointEpoch" | "peerUid" | "trustedLocal" | "herdrLocation"> & {
  extensions?: ExtensionCapability[];
  herdrSessionPath?: string;
  acknowledgesReceipts?: boolean;
  livenessIntervalMs?: number;
};

export type ClientMessage =
  | { type: "register"; session: SessionRegistration; sessionId?: string; stateId?: string; scopeId?: string }
  | { type: "unregister" }
  | { type: "extension_capabilities_update"; extensions: ExtensionCapability[] }
  | { type: "list"; requestId: string }
  | { type: "send"; to: string; message: Message; targetId?: string; targetEpoch?: string }
  | { type: "message_receipt"; receipt: MessageReceipt }
  | { type: "cancel_message"; messageId: string }
  | { type: "cancel_ask"; messageId: string }
  | { type: "presence"; name?: string; runtimeFallbackAlias?: boolean; status?: string; model?: string; contextPct?: number | null; contextTokens?: number | null; contextWindow?: number | null }
  | {
      type: "extension_publish";
      namespace: string;
      audience: "owner" | "capable";
      ownerEpoch?: string;
      ownerOnly?: boolean;
      payload: unknown;
    }
  | {
      type: "extension_state_commit";
      namespace: string;
      ownerEpoch: string;
      expectedRevision: number;
      payload: unknown;
    };

export type BrokerMessage =
  | { type: "registered"; sessionId: string; features?: string[] }
  | { type: "sessions"; requestId: string; sessions: SessionInfo[] }
  | { type: "message"; from: SessionInfo; message: Message }
  | { type: "presence_update"; session: SessionInfo }
  | { type: "session_joined"; session: SessionInfo }
  | { type: "session_left"; sessionId: string }
  | { type: "error"; error: string; code?: string; holder?: SessionHolder }
  | ({ type: "delivered"; messageId: string } & DeliveryDetails)
  | ({ type: "delivery_failed"; messageId: string; reason: string } & DeliveryDetails)
  | { type: "message_receipt"; from: SessionInfo; receipt: MessageReceipt }
  | { type: "message_control"; from: SessionInfo; control: MessageControl }
  | { type: "extension_owner"; namespace: string; ownerId?: string; ownerEpoch?: string }
  | {
      type: "extension_message";
      namespace: string;
      fromSessionId: string;
      ownerId?: string;
      ownerEpoch?: string;
      payload: unknown;
    }
  | {
      type: "extension_state";
      namespace: string;
      revision: number;
      payload: unknown;
    }
  | {
      type: "extension_state_result";
      namespace: string;
      committed: boolean;
      revision: number;
      reason?: string;
    };
