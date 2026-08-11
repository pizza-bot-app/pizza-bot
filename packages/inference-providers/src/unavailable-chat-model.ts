/** Defers the missing-provider error until generation so setup routes can boot. */
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

export class UnavailableChatModel extends BaseChatModel {
  private readonly detail: string;

  constructor(detail = "No inference provider is configured.", params?: BaseChatModelParams) {
    super(params ?? {});
    this.detail = detail;
  }

  _llmType(): string {
    return "unavailable";
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    throw new Error(this.detail);
  }
}
