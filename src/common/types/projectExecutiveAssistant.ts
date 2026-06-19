/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

export type ProjectCommunicationChannel = 'email' | 'imessage' | 'sms' | 'rcs';

export type ProjectContact = {
  id: string;
  name: string;
  company?: string;
  role?: string;
  email?: string;
  phone?: string;
  preferredChannel: ProjectCommunicationChannel;
  notes?: string;
  approved: boolean;
  createTime: number;
  modifyTime: number;
};

export type ProjectOutboundStatus = 'draft' | 'pending-approval' | 'sent' | 'failed' | 'cancelled';

export type ProjectOutboundMessage = {
  id: string;
  contactId?: string;
  contactName?: string;
  channel: ProjectCommunicationChannel;
  to: string;
  subject?: string;
  body: string;
  status: ProjectOutboundStatus;
  requiresApproval: boolean;
  approvedAt?: number;
  sentAt?: number;
  failedAt?: number;
  error?: string;
  provider?: string;
  providerMessageId?: string;
  projectRef?: string;
  createTime: number;
  modifyTime: number;
};

export type ProjectInboundAssistantEmailStatus = 'saved' | 'needs-review' | 'failed';

export type ProjectInboundAssistantEmail = {
  id: string;
  outboundId?: string;
  contactId?: string;
  contactName?: string;
  channel: 'email';
  from: string;
  to?: string;
  subject?: string;
  body: string;
  status: ProjectInboundAssistantEmailStatus;
  receivedAt: number;
  provider: 'email-agentmail' | 'email-imap';
  providerMessageId?: string;
  inReplyTo?: string;
  references?: string[];
  projectRef?: string;
  matchReason: 'provider-message-id' | 'project-ref' | 'sender-subject' | 'manual-review';
  reviewReason?: string;
  attachmentCount: number;
  referenceFiles: string[];
  createTime: number;
};

export type ProjectExecutiveAssistantState = {
  contacts: ProjectContact[];
  outbound: ProjectOutboundMessage[];
  inbound: ProjectInboundAssistantEmail[];
};

export type ProjectOutboundCapability = {
  channel: ProjectCommunicationChannel;
  available: boolean;
  provider?: string;
  note: string;
};

export type CreateProjectContactParams = Omit<ProjectContact, 'id' | 'createTime' | 'modifyTime'>;

export type UpdateProjectContactParams = Partial<Omit<ProjectContact, 'id' | 'createTime' | 'modifyTime'>>;

export type CreateProjectOutboundParams = {
  contactId?: string;
  channel: ProjectCommunicationChannel;
  to: string;
  subject?: string;
  body: string;
  requiresApproval?: boolean;
};
