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
  createTime: number;
  modifyTime: number;
};

export type ProjectExecutiveAssistantState = {
  contacts: ProjectContact[];
  outbound: ProjectOutboundMessage[];
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
