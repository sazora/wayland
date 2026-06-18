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

const DEFAULT_STATE: ProjectExecutiveAssistantState = {
  contacts: [],
  outbound: [],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9][0-9().\-\s]{6,}$/;

const statePath = (workspace: string): string => path.join(workspace, WAYLAND_KNOWLEDGE_DIR, EA_FILE);

const normalizeChannel = (value: ProjectCommunicationChannel): ProjectCommunicationChannel => {
  if (value === 'rcs') return 'rcs';
  if (value === 'sms') return 'sms';
  if (value === 'imessage') return 'imessage';
  return 'email';
};

const normalizeTarget = (channel: ProjectCommunicationChannel, value: string): string => {
  const target = value.trim();
  if (!target) throw new Error('Recipient is required');
  if (channel === 'email' && !EMAIL_RE.test(target)) throw new Error('Recipient email is not valid');
  if ((channel === 'sms' || channel === 'rcs' || channel === 'imessage') && !PHONE_RE.test(target) && !EMAIL_RE.test(target)) {
    throw new Error('Recipient must be a phone number or iMessage email address');
  }
  return target;
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
    return plugins.find((plugin) => plugin.type === 'sms-twilio') ?? plugins.find((plugin) => plugin.type === 'bluebubbles') ?? plugins.find((plugin) => plugin.type === 'imessage') ?? null;
  }
  if (channel === 'rcs') {
    return plugins.find((plugin) => plugin.type === 'bluebubbles') ?? plugins.find((plugin) => plugin.type === 'imessage') ?? null;
  }
  return plugins.find((plugin) => plugin.type === 'bluebubbles') ?? plugins.find((plugin) => plugin.type === 'imessage') ?? null;
}

export function projectOutboundCapabilities(): ProjectOutboundCapability[] {
  const plugins = runningPlugins();
  const has = (types: string[]): BasePlugin | undefined => plugins.find((plugin) => types.includes(plugin.type));
  const email = has(['email-agentmail', 'email-imap']);
  const twilioSms = has(['sms-twilio']);
  const sms = twilioSms ?? has(['bluebubbles', 'imessage']);
  const appleMessages = has(['bluebubbles', 'imessage']);
  return [
    {
      channel: 'email',
      available: Boolean(email),
      provider: email?.type,
      note: email ? `Outbound email is available through ${email.type}.` : 'Configure AgentMail or IMAP/SMTP before sending external email.',
    },
    {
      channel: 'imessage',
      available: Boolean(appleMessages),
      provider: appleMessages?.type,
      note: appleMessages ? `iMessage is available through ${appleMessages.type}.` : 'Configure iMessage or BlueBubbles before sending Messages.',
    },
    {
      channel: 'sms',
      available: Boolean(sms),
      provider: sms?.type,
      note: twilioSms
        ? 'Business SMS is available through Twilio. US SMS may still require A2P 10DLC registration to avoid carrier filtering.'
        : sms
          ? `SMS can send through ${sms.type}. Apple Messages/BlueBubbles SMS still requires a paired iPhone with an active carrier line.`
          : 'Configure Twilio for business SMS, or iMessage/BlueBubbles for Apple relay SMS.',
    },
    {
      channel: 'rcs',
      available: Boolean(appleMessages),
      provider: appleMessages?.type,
      note: appleMessages
        ? 'RCS can only work through Apple Messages relay when the paired iPhone/carrier supports it.'
        : 'RCS requires Apple Messages/BlueBubbles plus a paired iPhone/carrier that supports RCS.',
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

export async function sendProjectOutbound(workspace: string, messageId: string): Promise<ProjectOutboundMessage> {
  const state = await readState(workspace);
  const message = state.outbound.find((item) => item.id === messageId);
  if (!message) throw new Error('Outbound message not found');
  if (message.requiresApproval && !message.approvedAt) throw new Error('Outbound message needs approval before sending');
  if (message.status === 'sent') return message;

  const plugin = pickPlugin(message.channel);
  const now = Date.now();
  if (!plugin) {
    message.status = 'failed';
    message.failedAt = now;
    message.modifyTime = now;
    message.error =
      message.channel === 'email'
        ? 'No running email sender is configured. Enable AgentMail or IMAP/SMTP.'
        : 'No running message sender is configured. Enable iMessage, BlueBubbles, or Twilio. SMS/RCS through Apple still requires a paired iPhone.';
    await writeState(workspace, state);
    return message;
  }

  try {
    const providerMessageId = await plugin.sendMessage(message.to, {
      type: 'text',
      text: message.body,
      subject: message.subject,
    });
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
