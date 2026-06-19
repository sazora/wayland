/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  approveProjectOutbound,
  clearProjectOutbound,
  createProjectContact,
  createProjectOutbound,
  EMAIL_OUTBOUND_FOOTER,
  formatProjectOutboundBody,
  ingestProjectAssistantEmailReply,
  PROJECT_ASSISTANT_BRAND,
  readProjectExecutiveAssistant,
  SMS_OUTBOUND_ONLY_NOTICE,
  sendProjectOutbound,
} from '@process/services/projectExecutiveAssistant/ProjectExecutiveAssistantService';
import type { IProject } from '@/common/types/project';
import type { IProjectService } from '@process/services/IProjectService';

let ws: string;
type MockChannelPlugin = {
  status: string;
  type: string;
  sendMessage?: unknown;
  getMessageStatus?: unknown;
};
const channelMocks = vi.hoisted(() => ({
  plugins: [] as MockChannelPlugin[],
}));

vi.mock('@process/channels', () => ({
  getChannelManager: () => ({
    getPluginManager: () => ({
      getAllPlugins: () => channelMocks.plugins,
    }),
  }),
}));

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-project-ea-'));
  channelMocks.plugins = [];
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe('ProjectExecutiveAssistantService', () => {
  it('stores project contacts and outbound drafts in the project workspace', async () => {
    const contact = await createProjectContact(ws, {
      name: 'Norman Wood',
      company: 'PennDOT',
      role: 'Project contact',
      email: 'norman@example.com',
      preferredChannel: 'email',
      approved: true,
    });

    const outbound = await createProjectOutbound(ws, {
      contactId: contact.id,
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
    });

    const state = await readProjectExecutiveAssistant(ws);
    expect(state.contacts).toHaveLength(1);
    expect(state.outbound).toHaveLength(1);
    expect(state.outbound[0]).toEqual(
      expect.objectContaining({
        id: outbound.id,
        contactName: 'Norman Wood',
        status: 'pending-approval',
      }),
    );
  });

  it('requires approval before sending and records missing provider failures', async () => {
    const outbound = await createProjectOutbound(ws, {
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
    });

    await expect(sendProjectOutbound(ws, outbound.id)).rejects.toThrow('needs approval');

    await approveProjectOutbound(ws, outbound.id);
    const failed = await sendProjectOutbound(ws, outbound.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('No running email sender');
  });

  it('auto-dispatches email and RCS drafts when approval is not required', async () => {
    const email = await createProjectOutbound(ws, {
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
      requiresApproval: false,
    });

    expect(email.status).toBe('failed');
    expect(email.requiresApproval).toBe(false);
    expect(email.error).toContain('No running email sender');

    const rcs = await createProjectOutbound(ws, {
      channel: 'rcs',
      to: '+14125550123',
      body: 'Text through Twilio.',
      requiresApproval: false,
    });

    expect(rcs.channel).toBe('sms');
    expect(rcs.status).toBe('failed');
    expect(rcs.requiresApproval).toBe(false);
    expect(rcs.error).toContain('No running Twilio sender');

    const state = await readProjectExecutiveAssistant(ws);
    expect(state.outbound.map((message) => message.status)).toEqual(['failed', 'failed']);
  });

  it('sends AgentMail email with the Project Assistant footer', async () => {
    const sendMessage = vi.fn().mockResolvedValue('AMsent');
    channelMocks.plugins = [
      {
        status: 'running',
        type: 'email-agentmail',
        sendMessage,
      },
    ];

    const outbound = await createProjectOutbound(ws, {
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
      requiresApproval: false,
    });

    expect(outbound.status).toBe('sent');
    expect(sendMessage).toHaveBeenCalledWith(
      'norman@example.com',
      expect.objectContaining({
        subject: 'Drone policy references',
        text: expect.stringContaining(`We imported the reference files.\n\n${EMAIL_OUTBOUND_FOOTER}\nProject Ref: WL-`),
      }),
    );
    expect(outbound.projectRef).toMatch(/^WL-[A-Z0-9]{10}$/);
  });

  it('marks Twilio sends as failed when the provider immediately reports undelivered', async () => {
    const sendMessage = vi.fn().mockResolvedValue('SMblocked');
    const getMessageStatus = vi.fn().mockResolvedValue({
      status: 'undelivered',
      errorCode: 30034,
      errorMessage: null,
    });
    channelMocks.plugins = [
      {
        status: 'running',
        type: 'sms-twilio',
        sendMessage,
        getMessageStatus,
      },
    ];

    const outbound = await createProjectOutbound(ws, {
      channel: 'sms',
      to: '+14125550123',
      body: 'Text through Twilio.',
      requiresApproval: false,
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(getMessageStatus).toHaveBeenCalledWith('SMblocked');
    expect(outbound.status).toBe('failed');
    expect(outbound.providerMessageId).toBe('SMblocked');
    expect(outbound.error).toContain('US A2P 10DLC');
  });

  it('adds the opt-out notice to Project Assistant SMS bodies', () => {
    expect(formatProjectOutboundBody('sms', 'Checking in on the file.')).toBe(
      `Checking in on the file.\n\n${SMS_OUTBOUND_ONLY_NOTICE}`,
    );
    expect(SMS_OUTBOUND_ONLY_NOTICE).toContain(PROJECT_ASSISTANT_BRAND);
  });

  it('upgrades legacy Project Assistant SMS footers to include CKSZ branding', () => {
    expect(formatProjectOutboundBody('sms', 'Checking in on the file.\n\nReply HELP for help or STOP to opt out.')).toBe(
      `Checking in on the file.\n\n${SMS_OUTBOUND_ONLY_NOTICE}`,
    );
  });

  it('adds the Project Assistant footer to email bodies', () => {
    expect(formatProjectOutboundBody('email', 'Checking in on the file.')).toBe(
      `Checking in on the file.\n\n${EMAIL_OUTBOUND_FOOTER}`,
    );
    expect(EMAIL_OUTBOUND_FOOTER).toContain(PROJECT_ASSISTANT_BRAND);
  });

  it('does not duplicate Project Assistant footers or add them to non-email/SMS channels', () => {
    const smsBody = `Checking in on the file.\n\n${SMS_OUTBOUND_ONLY_NOTICE}`;
    const emailBody = `Checking in on the file.\n\n${EMAIL_OUTBOUND_FOOTER}`;

    expect(formatProjectOutboundBody('sms', smsBody)).toBe(smsBody);
    expect(formatProjectOutboundBody('email', emailBody)).toBe(emailBody);
    expect(formatProjectOutboundBody('imessage', 'Checking in on the file.')).toBe('Checking in on the file.');
    expect(formatProjectOutboundBody('rcs', 'Checking in on the file.')).toBe('Checking in on the file.');
  });

  it('normalizes legacy iMessage and RCS outbound drafts to Twilio text', async () => {
    const imessageContact = await createProjectContact(ws, {
      name: 'Legacy iMessage Contact',
      phone: '+14125550123',
      preferredChannel: 'imessage',
      approved: true,
    });
    expect(imessageContact.preferredChannel).toBe('sms');

    const outbound = await createProjectOutbound(ws, {
      contactId: imessageContact.id,
      channel: 'rcs',
      to: '+14125550123',
      body: 'Text through Twilio.',
    });

    expect(outbound.channel).toBe('sms');
  });

  it('clears outbound history without removing project contacts', async () => {
    const contact = await createProjectContact(ws, {
      name: 'Seth Zora',
      email: 'seth@example.com',
      phone: '+14127087088',
      preferredChannel: 'sms',
      approved: true,
    });
    await createProjectOutbound(ws, {
      contactId: contact.id,
      channel: 'sms',
      to: '+14127087088',
      body: 'Test',
    });

    const cleared = await clearProjectOutbound(ws);

    expect(cleared.contacts).toHaveLength(1);
    expect(cleared.contacts[0]?.id).toBe(contact.id);
    expect(cleared.outbound).toEqual([]);
    await expect(sendProjectOutbound(ws, 'missing-after-clear')).rejects.toThrow('Outbound message not found');
  });

  it('pipes AgentMail replies back into the project by provider message id', async () => {
    const sendMessage = vi.fn().mockResolvedValue('<agentmail-sent-1@agentmail.to>');
    channelMocks.plugins = [
      {
        status: 'running',
        type: 'email-agentmail',
        sendMessage,
      },
    ];
    const outbound = await createProjectOutbound(ws, {
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
      requiresApproval: false,
    });
    expect(outbound.status).toBe('sent');

    const result = await ingestProjectAssistantEmailReply(
      {
        id: '<reply-1@example.com>',
        platform: 'email-agentmail',
        chatId: 'norman@example.com',
        user: { id: 'norman@example.com', displayName: 'Norman Wood' },
        content: { type: 'text', text: 'Looks good. Send the updated package.' },
        timestamp: Date.parse('2026-06-18T20:00:00Z'),
        replyToMessageId: '<agentmail-sent-1@agentmail.to>',
        email: {
          from: 'norman@example.com',
          to: 'assistant@agentmail.to',
          subject: 'Re: Drone policy references',
          messageId: '<reply-1@example.com>',
          inReplyTo: '<agentmail-sent-1@agentmail.to>',
          references: ['<agentmail-sent-1@agentmail.to>'],
        },
      },
      projectService([project()])
    );

    expect(result.handled).toBe(true);
    if (result.handled) expect(result.status).toBe('saved');
    const state = await readProjectExecutiveAssistant(ws);
    expect(state.inbound).toHaveLength(1);
    expect(state.inbound[0]).toEqual(
      expect.objectContaining({
        outboundId: outbound.id,
        from: 'norman@example.com',
        status: 'saved',
        matchReason: 'provider-message-id',
      }),
    );
    expect(state.inbound[0]?.referenceFiles[0]).toMatch(/assistant-reply-/);
  });

  it('uses Project Ref as a fallback and marks weak subject matches for review', async () => {
    const outbound = await createProjectOutbound(ws, {
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Project update',
      body: 'Checking in.',
    });
    await approveProjectOutbound(ws, outbound.id);
    const state = await readProjectExecutiveAssistant(ws);
    state.outbound[0] = {
      ...state.outbound[0]!,
      status: 'sent',
      provider: 'email-agentmail',
      providerMessageId: '<sent-without-thread@agentmail.to>',
      sentAt: Date.now(),
    };
    await fs.writeFile(path.join(ws, '.wayland', 'executive-assistant.json'), `${JSON.stringify(state, null, 2)}\n`);

    const refResult = await ingestProjectAssistantEmailReply(
      {
        id: '<reply-ref@example.com>',
        platform: 'email-agentmail',
        chatId: 'norman@example.com',
        user: { id: 'norman@example.com', displayName: 'Norman Wood' },
        content: { type: 'text', text: `Received.\n\nProject Ref: ${outbound.projectRef}` },
        timestamp: Date.now(),
        email: {
          from: 'norman@example.com',
          to: 'assistant@agentmail.to',
          subject: 'different subject',
          messageId: '<reply-ref@example.com>',
        },
      },
      projectService([project()])
    );
    expect(refResult.handled).toBe(true);
    if (refResult.handled) expect(refResult.status).toBe('saved');

    const weakResult = await ingestProjectAssistantEmailReply(
      {
        id: '<reply-weak@example.com>',
        platform: 'email-agentmail',
        chatId: 'norman@example.com',
        user: { id: 'norman@example.com', displayName: 'Norman Wood' },
        content: { type: 'text', text: 'Reply without headers or project ref.' },
        timestamp: Date.now(),
        email: {
          from: 'norman@example.com',
          to: 'assistant@agentmail.to',
          subject: 'Re: Project update',
          messageId: '<reply-weak@example.com>',
        },
      },
      projectService([project()])
    );
    expect(weakResult.handled).toBe(true);
    if (weakResult.handled) expect(weakResult.status).toBe('needs-review');
  });
});

function project(overrides: Partial<IProject> = {}): IProject {
  return {
    id: 'project-1',
    name: 'Test Project',
    workspace: ws,
    pinned: false,
    createTime: Date.now(),
    modifyTime: Date.now(),
    ...overrides,
  };
}

function projectService(projects: IProject[]): IProjectService {
  return {
    createProject: vi.fn(),
    updateProject: vi.fn(),
    removeProject: vi.fn(),
    getProject: vi.fn(async (id: string) => projects.find((candidate) => candidate.id === id) ?? null),
    listProjects: vi.fn(async () => projects),
    getProjectConversations: vi.fn(),
    assignConversation: vi.fn(),
    removeConversationFromProject: vi.fn(),
  } as unknown as IProjectService;
}
