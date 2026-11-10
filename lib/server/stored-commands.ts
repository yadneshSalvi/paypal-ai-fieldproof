import type { PaymentCommand } from "@fracture/paypal-core";
import { openPrivate, sealPrivate } from "./private-values";

function context(command: PaymentCommand): string { return `payment-wallet:${command.scope.tenantId}:${command.scope.projectId}:${command.operationId}`; }
export function storePaymentCommand(command: PaymentCommand): PaymentCommand {
  if (command.action.kind !== "create_order" || !command.action.savedWallet) return command;
  return { ...command, action: { ...command.action, savedWallet: { ...command.action.savedWallet, vaultId: sealPrivate(command.action.savedWallet.vaultId, context(command)) } } };
}
export function readPaymentCommand(command: PaymentCommand): PaymentCommand {
  if (command.action.kind !== "create_order" || !command.action.savedWallet) return command;
  const vaultId = command.action.savedWallet.vaultId;
  if (!vaultId.startsWith("v1.")) throw new Error("A stored saved-wallet command must contain an encrypted payment source.");
  return { ...command, action: { ...command.action, savedWallet: { ...command.action.savedWallet, vaultId: openPrivate<string>(vaultId, context(command)) } } };
}
