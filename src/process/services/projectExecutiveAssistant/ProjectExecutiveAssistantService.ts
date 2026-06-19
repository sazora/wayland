/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'fs/promises';
import path from 'path';
import type { IProject } from '@/common/types/project';
import { uuid } from '@/common/utils';
import type {
  CreateProjectContactParams,
  CreateProjectOutboundParams,
  ProjectInboundAssistantEmail,
  ProjectCommunicationChannel,
  ProjectContact,
  ProjectExecutiveAssistantState,
  ProjectOutboundCapability,
  ProjectOutboundMessage,
  UpdateProjectContactParams,
} from '@/common/types/projectExecutiveAssistant';
import { getChannelManager } from '@process/channels';
import type { IUnifiedAttachment, IUnifiedIncomingMessage } from '@process/channels/types';
import type { BasePlugin } from '@process/channels';
import type { IProjectService } from '@process/services/IProjectService';
import { WAYLAND_KNOWLEDGE_DIR } from '@process/services/projectKnowledge/bootstrap';
import { writeProjectReferenceFile } from '@process/services/projectKnowledge/knowledge';

const EA_FILE = 'executive-assistant.json';
const MAX_OUTBOUND_RECORDS = 500;
const MAX_INBOUND_RECORDS = 500;
export const PROJECT_ASSISTANT_BRAND = 'CKSZ / AerdiA';
const LEGACY_SMS_OUTBOUND_ONLY_NOTICE = 'Reply HELP for help or STOP to opt out.';
export const SMS_OUTBOUND_ONLY_NOTICE = `${PROJECT_ASSISTANT_BRAND}: Reply HELP for help or STOP to opt out.`;
export const EMAIL_OUTBOUND_FOOTER = [
  '--',
  `${PROJECT_ASSISTANT_BRAND} Project Assistant`,
  `Project coordination message from ${PROJECT_ASSISTANT_BRAND}.`,
  'If this reached you in error, reply to this email and let us know.',
].join('\n');
export const PROJECT_ASSISTANT_REF_PREFIX = 'WL';

const DEFAULT_STATE: ProjectExecutiveAssistantState = {
  contacts: [],
  outbound: [],
  inbound: [],
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

export const formatProjectOutboundBody = (channel: ProjectCommunicationChannel, body: string, projectRef?: string): string => {
  const trimmed = body.trim();
  if (channel === 'email') {
    const footer = projectRef ? `${EMAIL_OUTBOUND_FOOTER}\nProject Ref: ${projectRef}` : EMAIL_OUTBOUND_FOOTER;
    if (projectRef && new RegExp(`\\bProject Ref:\\s*${escapeRegex(projectRef)}\\b`, 'i').test(trimmed)) return trimmed;
    if (!projectRef && trimmed.includes(EMAIL_OUTBOUND_FOOTER)) return trimmed;
    return `${trimmed}\n\n${footer}`;
  }
  if (channel !== 'sms') return trimmed;
  if (trimmed.includes(SMS_OUTBOUND_ONLY_NOTICE)) return trimmed;
  if (trimmed.includes(LEGACY_SMS_OUTBOUND_ONLY_NOTICE)) {
    return trimmed.replace(LEGACY_SMS_OUTBOUND_ONLY_NOTICE, SMS_OUTBOUND_ONLY_NOTICE);
  }
  return `${trimmed}\n\n${SMS_OUTBOUND_ONLY_NOTICE}`;
};

const normalizeState = (raw: Partial<ProjectExecutiveAssistantState> | null | undefined): ProjectExecutiveAssistantState => ({
  contacts: Array.isArray(raw?.contacts) ? raw.contacts : [],
  outbound: Array.isArray(raw?.outbound) ? raw.outbound : [],
  inbound: Array.isArray(raw?.inbound) ? raw.inbound : [],
});

async function readState(workspace: string): Promise<ProjectExecutiveAssistantState> {
  try {
    const raw = await fs.readFile(statePath(workspace), 'utf-8');
    return normalizeState(JSON.parse(raw) as Partial<ProjectExecutiveAssistantState>);
  } catch {
    return { ...DEFAULT_STATE, contacts: [], outbound: [], inbound: [] };
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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newProjectRef(): string {
  return `${PROJECT_ASSISTANT_REF_PREFIX}-${`${uuid()}${uuid()}`.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

function normalizeMessageId(value: string | undefined): string {
  return (value ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
}

function normalizeAddress(value: string | undefined): string {
  const raw = (value ?? '').trim().toLowerCase();
  const match = raw.match(/<([^>]+)>/);
  return (match?.[1] ?? raw).trim();
}

function normalizeSubject(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/^((re|fw|fwd):\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function projectRefFromText(...values: Array<string | undefined>): string | undefined {
  const text = values.filter(Boolean).join('\n');
  const match = text.match(/\bProject Ref:\s*(WL-[A-Z0-9-]{6,})\b/i);
  return match?.[1]?.toUpperCase();
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
    projectRef: channel === 'email' ? newProjectRef() : undefined,
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
      text: formatProjectOutboundBody(sendChannel, message.body, message.projectRef),
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

type ProjectAssistantReplyMatch = {
  project: IProject;
  state: ProjectExecutiveAssistantState;
  outbound: ProjectOutboundMessage;
  score: number;
  reason: ProjectInboundAssistantEmail['matchReason'];
};

export type ProjectAssistantEmailReplyIngestResult =
  | { handled: true; status: 'saved' | 'needs-review'; projectId: string; inbound: ProjectInboundAssistantEmail }
  | { handled: false; reason: 'not-email-agentmail' | 'no-match' | 'ambiguous' | 'missing-project-workspace' };

export async function ingestProjectAssistantEmailReply(
  message: IUnifiedIncomingMessage,
  projectService: IProjectService
): Promise<ProjectAssistantEmailReplyIngestResult> {
  if (message.platform !== 'email-agentmail' && message.platform !== 'email-imap') {
    return { handled: false, reason: 'not-email-agentmail' };
  }

  const projects = await projectService.listProjects();
  const matches: ProjectAssistantReplyMatch[] = [];
  const inboundMessageId = normalizeMessageId(message.email?.messageId || message.id);
  const inReplyTo = normalizeMessageId(message.email?.inReplyTo || message.replyToMessageId);
  const references = (message.email?.references ?? []).map(normalizeMessageId).filter(Boolean);
  const projectRef = projectRefFromText(message.content.text, message.email?.subject);
  const from = normalizeAddress(message.email?.from || message.user.id);
  const inboundSubject = normalizeSubject(message.email?.subject);

  for (const project of projects) {
    if (!project.workspace) continue;
    const state = await readState(project.workspace);
    for (const outbound of state.outbound) {
      if (outbound.channel !== 'email' || outbound.status !== 'sent') continue;
      const providerMessageId = normalizeMessageId(outbound.providerMessageId);
      const outboundRef = outbound.projectRef?.toUpperCase();
      const outboundSubject = normalizeSubject(outbound.subject);
      const outboundTo = normalizeAddress(outbound.to);

      if (providerMessageId && (providerMessageId === inReplyTo || references.includes(providerMessageId))) {
        matches.push({ project, state, outbound, score: 100, reason: 'provider-message-id' });
        continue;
      }
      if (outboundRef && projectRef && outboundRef === projectRef) {
        matches.push({ project, state, outbound, score: 90, reason: 'project-ref' });
        continue;
      }
      if (from && outboundTo && from === outboundTo && inboundSubject && outboundSubject && inboundSubject === outboundSubject) {
        matches.push({ project, state, outbound, score: 55, reason: 'sender-subject' });
      }
    }
  }

  if (matches.length === 0) return { handled: false, reason: 'no-match' };
  matches.sort((a, b) => b.score - a.score);
  const best = matches[0]!;
  const tied = matches.filter((match) => match.score === best.score);
  if (tied.length > 1) return { handled: false, reason: 'ambiguous' };
  if (!best.project.workspace) return { handled: false, reason: 'missing-project-workspace' };

  const status: Extract<ProjectInboundAssistantEmail['status'], 'saved' | 'needs-review'> =
    best.score >= 80 ? 'saved' : 'needs-review';
  const provider: ProjectInboundAssistantEmail['provider'] =
    message.platform === 'email-imap' ? 'email-imap' : 'email-agentmail';
  const now = Date.now();
  const body = message.content.text?.trim() || '(no body text)';
  const referenceFiles = await saveInboundReferences(best.project.workspace, best.project, message, best.outbound, status);
  const inbound: ProjectInboundAssistantEmail = {
    id: uuid(),
    outboundId: best.outbound.id,
    contactId: best.outbound.contactId,
    contactName: best.outbound.contactName,
    channel: 'email',
    from,
    to: message.email?.to,
    subject: message.email?.subject,
    body,
    status,
    receivedAt: message.timestamp || now,
    provider,
    providerMessageId: inboundMessageId || undefined,
    inReplyTo: message.email?.inReplyTo || message.replyToMessageId,
    references: message.email?.references ? [...message.email.references] : undefined,
    projectRef: best.outbound.projectRef || projectRef,
    matchReason: status === 'needs-review' ? 'manual-review' : best.reason,
    reviewReason: status === 'needs-review' ? 'Weak sender/subject match; review before acting on the reply.' : undefined,
    attachmentCount: message.content.attachments?.length ?? 0,
    referenceFiles,
    createTime: now,
  };

  if (inbound.providerMessageId && best.state.inbound.some((item) => item.providerMessageId === inbound.providerMessageId)) {
    return { handled: true, status, projectId: best.project.id, inbound };
  }

  best.state.inbound.unshift(inbound);
  best.state.inbound = best.state.inbound.slice(0, MAX_INBOUND_RECORDS);
  await writeState(best.project.workspace, best.state);
  return { handled: true, status, projectId: best.project.id, inbound };
}

async function saveInboundReferences(
  workspace: string,
  project: IProject,
  message: IUnifiedIncomingMessage,
  outbound: ProjectOutboundMessage,
  status: ProjectInboundAssistantEmail['status']
): Promise<string[]> {
  const receivedAt = new Date(message.timestamp || Date.now()).toISOString();
  const subject = message.email?.subject?.trim() || '(no subject)';
  const from = normalizeAddress(message.email?.from || message.user.id) || '(unknown sender)';
  const body = message.content.text?.trim() || '(no body text)';
  const prefix = `assistant-reply-${Date.now()}-${safeFileSegment(subject)}`;
  const referenceFiles: string[] = [];
  const note = await writeProjectReferenceFile(
    workspace,
    `${prefix}.md`,
    [
      `# Assistant email reply: ${subject}`,
      '',
      `- Project: ${project.name}`,
      `- From: ${from}`,
      `- To: ${message.email?.to || '(unknown recipient)'}`,
      `- Received: ${receivedAt}`,
      `- Status: ${status}`,
      `- Match: ${outbound.projectRef ? `Project Ref ${outbound.projectRef}` : outbound.providerMessageId || outbound.id}`,
      `- Original outbound: ${outbound.subject || outbound.id}`,
      '',
      '## Body',
      body,
    ].join('\n')
  );
  referenceFiles.push(note.name);

  const attachments = message.content.attachments ?? [];
  for (const attachment of attachments) {
    const saved = await saveLocalAttachment(workspace, prefix, attachment);
    if (saved) referenceFiles.push(saved);
  }

  return referenceFiles;
}

async function saveLocalAttachment(workspace: string, prefix: string, attachment: IUnifiedAttachment): Promise<string | null> {
  if (!attachment.localPath) return null;
  try {
    const bytes = await fs.readFile(attachment.localPath);
    const saved = await writeProjectReferenceFile(
      workspace,
      `${prefix}-${safeFileSegment(attachment.fileName || attachment.fileId || 'attachment')}`,
      bytes
    );
    return saved.name;
  } catch {
    return null;
  }
}

function safeFileSegment(value: string): string {
  return value
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .replace(/\s+/g, '-')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'email';
}
