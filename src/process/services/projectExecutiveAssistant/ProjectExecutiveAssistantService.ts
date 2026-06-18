/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import { uuid } from '@/common/utils';
import type {
  CreateProjectContactParams,
  CreateProjectOutboundParams,
  ProjectCommunicationChannel,
  ProjectContact,
  ProjectExecutiveAssistantState,
  ProjectOutboundCapability,
  ProjectOutboundMessage,
  UpdateProjectContactParams,
} from '@/common/types/projectExecutiveAssistant';
import { getChannelManager } from '@process/channels';
import type { BasePlugin } from '@process/channels';
import { WAYLAND_KNOWLEDGE_DIR } from '@process/services/projectKnowledge/bootstrap';

const EA_FILE = 'executive-assistant.json';
const MAX_OUTBOUND_RECORDS = 500;
export const SMS_OUTBOUND_ONLY_NOTICE = 'Reply STOP to opt out. For help, contact your AerdiA project contact.';

const DEFAULT_STATE: ProjectExecutiveAssistantState = {
  contacts: [],
  outbound: [],
};

type DeliveryStatus = {
  status?: string;
  errorCode?: number | string | null;
  errorMessage?: string | null;
};

type DeliveryStatusPlugin = BasePlugin & {
  getMessageStatus?: (messageId: string) => Promise<DeliveryStatus | null>;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9().\-\s]{6,}$/;

const statePath = (workspace: string): string => path.join(workspace, WAYLAND_KNOWLEDGE_DIR, EA_FILE);

const normalizeChannel = (value: ProjectCommunicationChannel): ProjectCommunicationChannel => {
  return value === 'email' ? 'email' : 'sms';
};

const normalizeTarget = (channel: ProjectCommunicationChannel, value: string): string => {
  const target = value.trim();
  if (!target) throw new Error('Recipient is required');
  if (channel === 'email' && !EMAIL_RE.test(target)) throw new Error('Recipient email is not valid');
  if (channel !== 'email' && !PHONE_RE.test(target)) {
    throw new Error('Recipient must be a phone number for Twilio text messaging');
  }
  return target;
};

export const formatProjectOutboundBody = (channel: ProjectCommunicationChannel, body: string): string => {
  const trimmed = body.trim();
  if (channel !== 'sms') return trimmed;
  if (trimmed.includes(SMS_OUTBOUND_ONLY_NOTICE)) return trimmed;
  return `${trimmed}\n\n${SMS_OUTBOUND_ONLY_NOTICE}`;
};

const normalizeState = (raw: Partial<ProjectExecutiveAssistantState> | null | undefined): ProjectExecutiveAssistantState => ({
  contacts: Array.isArray(raw?.contacts) ? raw.contacts : [],
  outbound: Array.isArray(raw?.outbound) ? raw.outbound : [],
});

async function readState(workspace: string): Promise<ProjectExecutiveAssistantState> {
  try {
    const raw = await fs.readFile(statePath(workspace), 'utf-8');
    return normalizeState(JSON.parse(raw) as Partial<ProjectExecutiveAssistantState>);
  } catch {
    return { ...DEFAULT_STATE, contacts: [], outbound: [] };
  }
}

async function writeState(workspace: string, state: ProjectExecutiveAssistantState): Promise<void> {
  const filePath = statePath(workspace);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
}

function runningPlugins(): BasePlugin[] {
  const manager = getChannelManager().getPluginManager();
  return manager?.getAllPlugins().filter((plugin) => plugin.status === 'running') ?? [];
}

function pickPlugin(channel: ProjectCommunicationChannel): BasePlugin | null {
  const plugins = runningPlugins();
  if (channel === 'email') {
    return plugins.find((plugin) => plugin.type === 'email-agentmail') ?? plugins.find((plugin) => plugin.type === 'email-imap') ?? null;
  }
  if (channel === 'sms') {
    return plugins.find((plugin) => plugin.type === 'sms-twilio') ?? null;
  }
  return null;
}

async function readDeliveryStatus(plugin: BasePlugin, providerMessageId: string): Promise<DeliveryStatus | null> {
  const statusReader = (plugin as DeliveryStatusPlugin).getMessageStatus;
  if (typeof statusReader !== 'function') return null;
  try {
    return await statusReader.call(plugin, providerMessageId);
  } catch {
    return null;
  }
}

const providerDeliveryFailed = (status: DeliveryStatus | null): boolean => {
  const normalized = status?.status?.toLowerCase();
  return normalized === 'failed' || normalized === 'undelivered';
};

const formatDeliveryError = (status: DeliveryStatus): string => {
  const code = status.errorCode ? ` ${status.errorCode}` : '';
  const providerMessage = status.errorMessage ? `: ${status.errorMessage}` : '';
  if (String(status.errorCode) === '30034') {
    return `Twilio delivery failed${code}: US A2P 10DLC blocked this message because the sender is not registered for US application-to-person texting.`;
  }
  return `Provider delivery ${status.status || 'failed'}${code}${providerMessage}`;
};

export function projectOutboundCapabilities(): ProjectOutboundCapability[] {
  const plugins = runningPlugins();
  const has = (types: string[]): BasePlugin | undefined => plugins.find((plugin) => types.includes(plugin.type));
  const email = has(['email-agentmail', 'email-imap']);
  const twilioSms = has(['sms-twilio']);
  return [
    {
      channel: 'email',
      available: Boolean(email),
      provider: email?.type,
      note: email ? `Outbound email is available through ${email.type}.` : 'Configure AgentMail or IMAP/SMTP before sending external email.',
    },
    {
      channel: 'sms',
      available: Boolean(twilioSms),
      provider: twilioSms?.type,
      note: twilioSms
        ? 'Business text messaging is available through Twilio. RCS requires Twilio RCS onboarding and a verified sender before WL can use it.'
        : 'Configure Twilio before sending project text messages.',
    },
  ];
}

export async function readProjectExecutiveAssistant(workspace: string): Promise<ProjectExecutiveAssistantState> {
  return readState(workspace);
}

export async function createProjectContact(workspace: string, params: CreateProjectContactParams): Promise<ProjectContact> {
  const state = await readState(workspace);
  const now = Date.now();
  const preferredChannel = normalizeChannel(params.preferredChannel);
  const contact: ProjectContact = {
    id: uuid(),
    name: params.name.trim() || 'Unnamed contact',
    company: params.company?.trim() || undefined,
    role: params.role?.trim() || undefined,
    email: params.email?.trim() || undefined,
    phone: params.phone?.trim() || undefined,
    preferredChannel,
    notes: params.notes?.trim() || undefined,
    approved: params.approved,
    createTime: now,
    modifyTime: now,
  };
  if (contact.email && !EMAIL_RE.test(contact.email)) throw new Error('Contact email is not valid');
  if (contact.phone && !PHONE_RE.test(contact.phone)) throw new Error('Contact phone is not valid');
  state.contacts.unshift(contact);
  await writeState(workspace, state);
  return contact;
}

export async function updateProjectContact(
  workspace: string,
  contactId: string,
  updates: UpdateProjectContactParams,
): Promise<ProjectContact> {
  const state = await readState(workspace);
  const index = state.contacts.findIndex((contact) => contact.id === contactId);
  if (index < 0) throw new Error('Contact not found');
  const current = state.contacts[index]!;
  const next: ProjectContact = {
    ...current,
    ...updates,
    name: updates.name?.trim() || current.name,
    company: updates.company?.trim() || undefined,
    role: updates.role?.trim() || undefined,
    email: updates.email?.trim() || undefined,
    phone: updates.phone?.trim() || undefined,
    preferredChannel: updates.preferredChannel ? normalizeChannel(updates.preferredChannel) : current.preferredChannel,
    notes: updates.notes?.trim() || undefined,
    modifyTime: Date.now(),
  };
  if (next.email && !EMAIL_RE.test(next.email)) throw new Error('Contact email is not valid');
  if (next.phone && !PHONE_RE.test(next.phone)) throw new Error('Contact phone is not valid');
  state.contacts[index] = next;
  await writeState(workspace, state);
  return next;
}

export async function removeProjectContact(workspace: string, contactId: string): Promise<void> {
  const state = await readState(workspace);
  state.contacts = state.contacts.filter((contact) => contact.id !== contactId);
  await writeState(workspace, state);
}

export async function createProjectOutbound(workspace: string, params: CreateProjectOutboundParams): Promise<ProjectOutboundMessage> {
  const state = await readState(workspace);
  const now = Date.now();
  const channel = normalizeChannel(params.channel);
  const contact = params.contactId ? state.contacts.find((item) => item.id === params.contactId) : undefined;
  const to = normalizeTarget(channel, params.to);
  const message: ProjectOutboundMessage = {
    id: uuid(),
    contactId: contact?.id,
    contactName: contact?.name,
    channel,
    to,
    subject: params.subject?.trim() || undefined,
    body: params.body.trim(),
    status: params.requiresApproval === false ? 'draft' : 'pending-approval',
    requiresApproval: params.requiresApproval ?? true,
    createTime: now,
    modifyTime: now,
  };
  if (!message.body) throw new Error('Message body is required');
  state.outbound.unshift(message);
  state.outbound = state.outbound.slice(0, MAX_OUTBOUND_RECORDS);
  await writeState(workspace, state);
  if (message.requiresApproval === false) {
    return sendProjectOutbound(workspace, message.id);
  }
  return message;
}

export async function approveProjectOutbound(workspace: string, messageId: string): Promise<ProjectOutboundMessage> {
  const state = await readState(workspace);
  const message = state.outbound.find((item) => item.id === messageId);
  if (!message) throw new Error('Outbound message not found');
  const now = Date.now();
  message.status = 'draft';
  message.approvedAt = now;
  message.modifyTime = now;
  await writeState(workspace, state);
  return message;
}

export async function cancelProjectOutbound(workspace: string, messageId: string): Promise<ProjectOutboundMessage> {
  const state = await readState(workspace);
  const message = state.outbound.find((item) => item.id === messageId);
  if (!message) throw new Error('Outbound message not found');
  const now = Date.now();
  message.status = 'cancelled';
  message.modifyTime = now;
  await writeState(workspace, state);
  return message;
}

export async function clearProjectOutbound(workspace: string): Promise<ProjectExecutiveAssistantState> {
  const state = await readState(workspace);
  state.outbound = [];
  await writeState(workspace, state);
  return state;
}

export async function sendProjectOutbound(workspace: string, messageId: string): Promise<ProjectOutboundMessage> {
  const state = await readState(workspace);
  const message = state.outbound.find((item) => item.id === messageId);
  if (!message) throw new Error('Outbound message not found');
  if (message.requiresApproval && !message.approvedAt) throw new Error('Outbound message needs approval before sending');
  if (message.status === 'sent') return message;

  const sendChannel = normalizeChannel(message.channel);
  message.channel = sendChannel;
  const plugin = pickPlugin(sendChannel);
  const now = Date.now();
  if (!plugin) {
    message.status = 'failed';
    message.failedAt = now;
    message.modifyTime = now;
    message.error =
      message.channel === 'email'
        ? 'No running email sender is configured. Enable AgentMail or IMAP/SMTP.'
        : 'No running Twilio sender is configured. Project Assistant text messaging is Twilio-only.';
    await writeState(workspace, state);
    return message;
  }

  try {
    const providerMessageId = await plugin.sendMessage(message.to, {
      type: 'text',
      text: formatProjectOutboundBody(sendChannel, message.body),
      subject: message.subject,
    });
    const deliveryStatus = await readDeliveryStatus(plugin, providerMessageId);
    if (providerDeliveryFailed(deliveryStatus)) {
      message.status = 'failed';
      message.failedAt = Date.now();
      message.modifyTime = message.failedAt;
      message.provider = plugin.type;
      message.providerMessageId = providerMessageId;
      message.error = formatDeliveryError(deliveryStatus!);
      await writeState(workspace, state);
      return message;
    }
    message.status = 'sent';
    message.sentAt = Date.now();
    message.modifyTime = message.sentAt;
    message.provider = plugin.type;
    message.providerMessageId = providerMessageId;
    delete message.error;
  } catch (err) {
    message.status = 'failed';
    message.failedAt = Date.now();
    message.modifyTime = message.failedAt;
    message.provider = plugin.type;
    message.error = err instanceof Error ? err.message : String(err);
  }
  await writeState(workspace, state);
  return message;
}
