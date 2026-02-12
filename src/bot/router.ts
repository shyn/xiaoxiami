import type { Messenger } from "../im/messenger.js";
import type { Formatter } from "../im/formatter.js";
import type { StreamSink } from "../im/stream-sink.js";
import type { ConversationRef, InboundEvent, UserRef } from "../im/types.js";
import type { Config } from "../config.js";
import { AuthStore } from "../auth.js";
import { PermissionStore } from "../permissions-store.js";
import { ChatController } from "./controller.js";

export interface RouterOptions {
  config: Config;
  auth: AuthStore;
  permissions: PermissionStore;
  messenger: Messenger;
  fmt: Formatter;
  createStreamSink: (convo: ConversationRef) => StreamSink;
}

export class Router {
  private config: Config;
  private auth: AuthStore;
  private permissions: PermissionStore;
  private messenger: Messenger;
  private fmt: Formatter;
  private createStreamSink: (convo: ConversationRef) => StreamSink;

  private controllers = new Map<string, ChatController>();
  private controllerQueues = new Map<string, Promise<void>>();
  private controllerLastUsed = new Map<string, number>();

  private static readonly CONTROLLER_TTL_MS = 30 * 60 * 1000;
  private static readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

  constructor(opts: RouterOptions) {
    this.config = opts.config;
    this.auth = opts.auth;
    this.permissions = opts.permissions;
    this.messenger = opts.messenger;
    this.fmt = opts.fmt;
    this.createStreamSink = opts.createStreamSink;
  }

  private controllerKey(convo: ConversationRef): string {
    return `${convo.conversationId}:${convo.threadId ?? ""}`;
  }

  private getController(convo: ConversationRef): ChatController {
    const key = this.controllerKey(convo);
    this.controllerLastUsed.set(key, Date.now());
    let ctrl = this.controllers.get(key);
    if (!ctrl) {
      ctrl = new ChatController(
        this.messenger,
        this.fmt,
        convo,
        this.config,
        this.createStreamSink,
        this.permissions,
      );
      this.controllers.set(key, ctrl);
    }
    return ctrl;
  }

  private enqueue(convo: ConversationRef, fn: () => Promise<void>): void {
    const key = this.controllerKey(convo);
    const prev = this.controllerQueues.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn).catch((e) => {
      console.error(`[queue=${key}] Unhandled error in queued task:`, e);
    });
    this.controllerQueues.set(key, next);
  }

  cleanupStaleControllers = (): void => {
    const now = Date.now();
    for (const [key, lastUsed] of this.controllerLastUsed) {
      if (now - lastUsed > Router.CONTROLLER_TTL_MS) {
        const ctrl = this.controllers.get(key);
        if (ctrl) {
          console.log(`[cleanup] Disposing stale controller: ${key}`);
          ctrl.dispose();
          this.controllers.delete(key);
        }
        this.controllerQueues.delete(key);
        this.controllerLastUsed.delete(key);
      }
    }
  };

  get cleanupIntervalMs(): number {
    return Router.CLEANUP_INTERVAL_MS;
  }

  handleEvent = async (event: InboundEvent): Promise<void> => {
    switch (event.type) {
      case "action":
        await this.handleAction(event);
        break;
      case "command":
        await this.handleCommand(event);
        break;
      case "text":
        await this.handleText(event);
        break;
      case "image":
        await this.handleImage(event);
        break;
    }
  };

  private async handleAction(
    event: Extract<InboundEvent, { type: "action" }>,
  ): Promise<void> {
    const userId = Number(event.from.userId);
    console.log(`[router] handleAction: actionId=${event.actionId}, data=${event.data}, userId=${userId}`);
    if (!this.auth.isAuthorized(userId)) {
      await this.messenger.ackAction?.(event.ackHandle, "Unauthorized.", true);
      return;
    }
    if (!event.data) return;

    // Auth callbacks must bypass the queue to avoid deadlock:
    // the queued prompt task is blocked waiting for this callback to resolve.
    if (event.actionId === "auth") {
      const ctrl = this.getController(event.convo);
      console.log(`[router] Auth callback bypass queue: data=${event.data}`);
      await ctrl.handleCallback(event.ackHandle, event.actionId, event.data);
      return;
    }

    this.enqueue(event.convo, async () => {
      const ctrl = this.getController(event.convo);
      console.log(`[router] Routing to controller.handleCallback: actionId=${event.actionId}, data=${event.data}`);
      await ctrl.handleCallback(event.ackHandle, event.actionId, event.data);
    });
  }

  private async handleCommand(
    event: Extract<InboundEvent, { type: "command" }>,
  ): Promise<void> {
    const userId = Number(event.from.userId);
    const handled = await this.handleAuthCommand(
      event.convo,
      userId,
      event.from.displayName,
      event.command,
      event.args,
      event.raw,
    );
    if (handled) return;

    if (!this.auth.isAuthorized(userId)) {
      if (event.command === "/start") {
        await this.messenger.send(event.convo, {
          type: "text",
          text: "🔒 This bot is already paired to another user. Contact the owner for access.",
        });
      }
      return;
    }

    this.enqueue(event.convo, async () => {
      const ctrl = this.getController(event.convo);
      await ctrl.handleCommand(event.command, event.args);
    });
  }

  private async handleText(
    event: Extract<InboundEvent, { type: "text" }>,
  ): Promise<void> {
    const userId = Number(event.from.userId);
    if (!this.auth.isAuthorized(userId)) return;

    const isTmuxTopic = !!(event.raw && typeof event.raw === "object" && (event.raw as Record<string, unknown>).isTmuxTopic);

    this.enqueue(event.convo, async () => {
      const ctrl = this.getController(event.convo);
      if (isTmuxTopic) {
        await ctrl.handleTmuxTopicMessage(event.text);
      } else {
        await ctrl.handleMessage(event.text);
      }
    });
  }

  private async handleImage(
    event: Extract<InboundEvent, { type: "image" }>,
  ): Promise<void> {
    const userId = Number(event.from.userId);
    if (!this.auth.isAuthorized(userId)) return;

    this.enqueue(event.convo, async () => {
      const ctrl = this.getController(event.convo);
      await ctrl.handlePhoto(event.image, event.caption);
    });
  }

  private async handleAuthCommand(
    convo: ConversationRef,
    userId: number,
    username: string | undefined,
    command: string,
    args: string,
    raw?: unknown,
  ): Promise<boolean> {
    if (command === "/start" && !this.auth.isPaired()) {
      const chatType = this.extractChatType(raw);
      if (chatType && chatType !== "private") {
        await this.messenger.send(convo, {
          type: "text",
          text: "🔒 Owner pairing must be done in a private chat with the bot.",
        });
        return true;
      }
      this.auth.pair(userId, username);
      const lines = [
        `🔐 ${this.fmt.bold("Paired!")}`,
        "",
        "You are now the owner of this bot.",
        `Your user ID: ${this.fmt.code(String(userId))}`,
        "",
        `${this.fmt.bold("Owner commands:")}`,
        `/adduser ${this.fmt.escape("<user_id>")} — Allow another user`,
        `/removeuser ${this.fmt.escape("<user_id>")} — Remove a user`,
        `/users — List allowed users`,
        "",
        "Send /help to see all commands.",
      ];
      await this.messenger.send(convo, { type: "text", text: lines.join("\n") });
      return true;
    }

    if (!this.auth.isPaired()) {
      await this.messenger.send(convo, {
        type: "text",
        text: "🔒 Bot is not configured yet. Send /start in a private chat to pair as owner.",
      });
      return true;
    }

    if (this.auth.isOwner(userId)) {
      switch (command) {
        case "/adduser": {
          const targetId = Number(args.trim());
          if (!targetId || !Number.isInteger(targetId)) {
            await this.messenger.send(convo, {
              type: "text",
              text: `Usage: /adduser ${this.fmt.escape("<user_id>")}\n\nAsk the user to message @userinfobot to find their ID.`,
            });
            return true;
          }
          if (this.auth.addUser(targetId)) {
            await this.messenger.send(convo, {
              type: "text",
              text: `✅ User ${this.fmt.code(String(targetId))} added.`,
            });
          } else {
            await this.messenger.send(convo, {
              type: "text",
              text: `User ${this.fmt.code(String(targetId))} is already allowed.`,
            });
          }
          return true;
        }

        case "/removeuser": {
          const targetId = Number(args.trim());
          if (!targetId || !Number.isInteger(targetId)) {
            await this.messenger.send(convo, {
              type: "text",
              text: `Usage: /removeuser ${this.fmt.escape("<user_id>")}`,
            });
            return true;
          }
          if (this.auth.removeUser(targetId)) {
            await this.messenger.send(convo, {
              type: "text",
              text: `✅ User ${this.fmt.code(String(targetId))} removed.`,
            });
          } else if (this.auth.isOwner(targetId)) {
            await this.messenger.send(convo, { type: "text", text: "Cannot remove the owner." });
          } else {
            await this.messenger.send(convo, {
              type: "text",
              text: `User ${this.fmt.code(String(targetId))} is not in the allowed list.`,
            });
          }
          return true;
        }

        case "/users": {
          const data = this.auth.getData();
          const lines: string[] = [
            this.fmt.bold("Allowed Users"),
            "",
            `Owner: ${this.fmt.code(String(data.ownerId))}${data.ownerUsername ? ` (@${this.fmt.escape(data.ownerUsername)})` : ""}`,
            `Paired: ${data.pairedAt ?? "unknown"}`,
            "",
          ];
          if (data.allowedUserIds.length > 1) {
            const others = data.allowedUserIds.filter((id) => id !== data.ownerId);
            lines.push(this.fmt.bold("Other users:"));
            for (const id of others) {
              lines.push(`• ${this.fmt.code(String(id))}`);
            }
          } else {
            lines.push(this.fmt.italic("No other users added."));
          }
          lines.push(
            "",
            `/adduser ${this.fmt.escape("<id>")} — add user`,
            `/removeuser ${this.fmt.escape("<id>")} — remove user`,
          );
          await this.messenger.send(convo, { type: "text", text: lines.join("\n") });
          return true;
        }
      }
    }

    if (["/adduser", "/removeuser", "/users"].includes(command)) {
      await this.messenger.send(convo, { type: "text", text: "🔒 Owner-only command." });
      return true;
    }

    return false;
  }

  private extractChatType(raw: unknown): string | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    if (r.message && typeof r.message === "object") {
      const msg = r.message as Record<string, unknown>;
      if (msg.chat && typeof msg.chat === "object") {
        const chat = msg.chat as Record<string, unknown>;
        if (typeof chat.type === "string") return chat.type;
      }
    }
    return undefined;
  }
}
