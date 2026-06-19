/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type {
  ProjectCommunicationChannel,
  ProjectContact,
  ProjectExecutiveAssistantState,
  ProjectOutboundCapability,
  ProjectOutboundMessage,
} from '@/common/types/projectExecutiveAssistant';
import { Button, Checkbox, Input, Message, Modal, Select } from '@arco-design/web-react';
import { Check, Mail, MessageSquareText, Phone, Send, Trash2, UserPlus, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import styles from './projectCards.module.css';

type Props = {
  projectId: string;
  hasWorkspace: boolean;
  onSetWorkspace: () => void;
};

const CHANNEL_OPTIONS: Array<{ label: string; value: ProjectCommunicationChannel }> = [
  { label: 'Email', value: 'email' },
  { label: 'Text (Twilio)', value: 'sms' },
];

const defaultState: ProjectExecutiveAssistantState = { contacts: [], outbound: [], inbound: [] };

const channelIcon = (channel: ProjectCommunicationChannel): React.ReactNode => {
  if (channel === 'email') return <Mail size={14} />;
  if (channel === 'sms' || channel === 'rcs') return <Phone size={14} />;
  return <MessageSquareText size={14} />;
};

const normalizeComposerChannel = (channel: ProjectCommunicationChannel): ProjectCommunicationChannel => {
  return channel === 'email' ? 'email' : 'sms';
};

export const resolveContactDestination = (
  contact: Pick<ProjectContact, 'email' | 'phone'>,
  channel: ProjectCommunicationChannel,
): string => {
  if (channel === 'email') return contact.email || '';
  return contact.phone || '';
};

const timestamp = (value?: number): string => {
  if (!value) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
};

const statusTone = (status: ProjectOutboundMessage['status']): string => {
  if (status === 'sent') return 'text-success-6';
  if (status === 'failed') return 'text-danger-6';
  if (status === 'cancelled') return 'text-t-tertiary';
  return 'text-warning-6';
};

const pendingCount = (messages: ProjectOutboundMessage[]): number =>
  messages.filter((message) => message.status === 'pending-approval' || message.status === 'draft' || message.status === 'failed').length;

const ProjectExecutiveAssistantPanel: React.FC<Props> = ({ projectId, hasWorkspace, onSetWorkspace }) => {
  const [state, setState] = useState<ProjectExecutiveAssistantState>(defaultState);
  const [capabilities, setCapabilities] = useState<ProjectOutboundCapability[]>([]);
  const [selectedContactId, setSelectedContactId] = useState<string>('');
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [contactDraft, setContactDraft] = useState({
    name: '',
    company: '',
    role: '',
    email: '',
    phone: '',
    preferredChannel: 'email' as ProjectCommunicationChannel,
    approved: false,
  });
  const [messageDraft, setMessageDraft] = useState({
    channel: 'email' as ProjectCommunicationChannel,
    to: '',
    subject: '',
    body: '',
    requiresApproval: true,
  });

  const load = useCallback(async () => {
    if (!hasWorkspace) return;
    const [nextState, nextCapabilities] = await Promise.all([
      ipcBridge.project.readExecutiveAssistant.invoke({ id: projectId }),
      ipcBridge.project.readOutboundCapabilities.invoke(),
    ]);
    setState(nextState);
    setCapabilities(nextCapabilities);
  }, [hasWorkspace, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedContact = useMemo(
    () => state.contacts.find((contact) => contact.id === selectedContactId),
    [selectedContactId, state.contacts],
  );

  useEffect(() => {
    if (!selectedContact) return;
    const channel = normalizeComposerChannel(selectedContact.preferredChannel);
    setMessageDraft((current) => ({
      ...current,
      channel,
      to: resolveContactDestination(selectedContact, channel),
    }));
  }, [selectedContact]);

  const updateMessageChannel = (channel: ProjectCommunicationChannel) => {
    const normalizedChannel = normalizeComposerChannel(channel);
    setMessageDraft((draft) => ({
      ...draft,
      channel: normalizedChannel,
      to: selectedContact ? resolveContactDestination(selectedContact, normalizedChannel) : draft.to,
    }));
  };

  const createContact = async () => {
    try {
      await ipcBridge.project.createContact.invoke({
        id: projectId,
        contact: contactDraft,
      });
      setContactDraft({
        name: '',
        company: '',
        role: '',
        email: '',
        phone: '',
        preferredChannel: 'email',
        approved: false,
      });
      await load();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : 'Failed to save contact');
    }
  };

  const createOutbound = async () => {
    try {
      await ipcBridge.project.createOutbound.invoke({
        id: projectId,
        message: {
          contactId: selectedContactId || undefined,
          channel: messageDraft.channel,
          to: messageDraft.to,
          subject: messageDraft.subject,
          body: messageDraft.body,
          requiresApproval: messageDraft.requiresApproval,
        },
      });
      setMessageDraft((current) => ({ ...current, subject: '', body: '' }));
      await load();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : 'Failed to create outbound draft');
    }
  };

  const approveAndSend = async (message: ProjectOutboundMessage) => {
    setSendingId(message.id);
    try {
      if (message.requiresApproval && !message.approvedAt) {
        await ipcBridge.project.approveOutbound.invoke({ id: projectId, messageId: message.id });
      }
      const sent = await ipcBridge.project.sendOutbound.invoke({ id: projectId, messageId: message.id });
      if (sent.status === 'sent') Message.success('Message sent');
      else Message.error(sent.error || 'Message failed');
      await load();
    } catch (err) {
      Message.error(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSendingId(null);
    }
  };

  const cancel = async (messageId: string) => {
    await ipcBridge.project.cancelOutbound.invoke({ id: projectId, messageId });
    await load();
  };

  const clearOutbox = () => {
    Modal.confirm({
      title: 'Clear Assistant outbox?',
      content: 'This removes every draft, sent, failed, and cancelled Assistant outbox entry for this project. Contacts stay saved.',
      okText: 'Clear outbox',
      cancelText: 'Cancel',
      onOk: async () => {
        try {
          const nextState = await ipcBridge.project.clearOutbound.invoke({ id: projectId });
          setState(nextState);
          Message.success('Assistant outbox cleared');
        } catch (err) {
          Message.error(err instanceof Error ? err.message : 'Failed to clear Assistant outbox');
        }
      },
    });
  };

  if (!hasWorkspace) {
    return (
      <div className='mx-auto flex max-w-720px flex-col items-center gap-12px text-center'>
        <div className='text-15px font-700 text-t-primary'>Connect a workspace to use executive assistant tools</div>
        <div className='max-w-440px text-12px leading-relaxed text-t-secondary'>
          Contacts, drafts, and outbound history live inside this project's `.wayland` folder.
        </div>
        <Button type='primary' onClick={onSetWorkspace}>
          Set workspace
        </Button>
      </div>
    );
  }

  return (
    <div className={`mx-auto flex max-w-1400px flex-col gap-16px ${styles.assistantPanel}`}>
      <div className={`grid gap-14px p-16px ${styles.surface} ${styles.assistantHero}`}>
        <div>
          <div className='text-16px font-700 text-t-primary'>Project Assistant</div>
          <div className='mt-2px text-12px leading-relaxed text-t-secondary'>Contacts, message drafting, approvals, sending, and outbound history.</div>
        </div>
        <div className={`grid gap-8px ${styles.assistantStatusGrid}`}>
          <div className={styles.assistantStatusTile}>
            <span className={styles.assistantStatusValue}>{state.contacts.length}</span>
            <span className={styles.assistantStatusLabel}>contacts</span>
          </div>
          <div className={styles.assistantStatusTile}>
            <span className={styles.assistantStatusValue}>{pendingCount(state.outbound)}</span>
            <span className={styles.assistantStatusLabel}>need action</span>
          </div>
          <div className={styles.assistantCapabilityRail}>
            {capabilities.map((capability) => (
              <span
                key={capability.channel}
                className='inline-flex items-center gap-5px rd-full px-8px py-4px text-11px'
                style={{
                  background: capability.available ? 'var(--color-primary-light-1)' : 'var(--color-fill-1)',
                  color: capability.available ? 'rgb(var(--primary-6))' : 'var(--color-text-3)',
                  border: '1px solid var(--color-border-2)',
                }}
                title={capability.note}
              >
                {channelIcon(capability.channel)}
                {capability.provider || capability.channel}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className={`grid gap-14px ${styles.assistantPrimaryGrid}`}>
        <section className={`p-16px ${styles.surface} ${styles.assistantContactsPane}`}>
          <div className='mb-12px flex items-center justify-between gap-10px'>
            <div>
              <h2 className='m-0 text-14px font-700 text-t-primary'>Contacts</h2>
              <p className='m-0 mt-2px text-12px text-t-secondary'>Pick a saved recipient or add a new one.</p>
            </div>
          </div>

          <div className={`grid gap-8px ${styles.assistantContactForm}`}>
            <Input placeholder='Name' value={contactDraft.name} onChange={(name) => setContactDraft((draft) => ({ ...draft, name }))} />
            <Input placeholder='Company' value={contactDraft.company} onChange={(company) => setContactDraft((draft) => ({ ...draft, company }))} />
            <Input placeholder='Role' value={contactDraft.role} onChange={(role) => setContactDraft((draft) => ({ ...draft, role }))} />
            <Select
              value={contactDraft.preferredChannel}
              options={CHANNEL_OPTIONS}
              onChange={(preferredChannel) => setContactDraft((draft) => ({ ...draft, preferredChannel }))}
            />
            <Input placeholder='Email' value={contactDraft.email} onChange={(email) => setContactDraft((draft) => ({ ...draft, email }))} />
            <Input placeholder='Phone' value={contactDraft.phone} onChange={(phone) => setContactDraft((draft) => ({ ...draft, phone }))} />
          </div>
          <div className='mt-10px flex flex-wrap items-center justify-between gap-10px'>
            <Checkbox
              checked={contactDraft.approved}
              onChange={(approved) => setContactDraft((draft) => ({ ...draft, approved }))}
            >
              Approved contact
            </Checkbox>
            <Button type='primary' icon={<UserPlus size={14} />} onClick={createContact} disabled={!contactDraft.name.trim()}>
              Add contact
            </Button>
          </div>

          <div className={`mt-14px flex flex-col gap-8px ${styles.assistantContactList}`}>
            {state.contacts.map((contact) => (
              <button
                key={contact.id}
                type='button'
                className={`cursor-pointer border-none text-left ${styles.card} px-12px py-10px`}
                style={{ background: selectedContactId === contact.id ? 'var(--color-primary-light-1)' : undefined }}
                onClick={() => setSelectedContactId(contact.id)}
              >
                <div className='flex items-center justify-between gap-10px'>
                  <span className='min-w-0 flex-1 truncate text-13px font-700 text-t-primary'>{contact.name}</span>
                  <span className='inline-flex items-center gap-4px text-11px text-t-tertiary'>
                    {channelIcon(contact.preferredChannel)}
                    {contact.approved ? 'approved' : 'review'}
                  </span>
                </div>
                <div className='mt-2px truncate text-12px text-t-secondary'>
                  {[contact.role, contact.company, contact.email, contact.phone].filter(Boolean).join(' · ')}
                </div>
              </button>
            ))}
            {state.contacts.length === 0 && (
              <div className='rd-8px border border-dashed border-2 px-12px py-14px text-center text-12px text-t-tertiary'>
                No contacts yet.
              </div>
            )}
          </div>
        </section>

        <section className={`p-16px ${styles.surface} ${styles.assistantComposerPane}`}>
          <div className='flex flex-wrap items-start justify-between gap-10px'>
            <div>
              <h2 className='m-0 text-14px font-700 text-t-primary'>Compose</h2>
              <p className='m-0 mt-2px text-12px text-t-secondary'>Write the message, then stage it for approval or send it immediately.</p>
            </div>
            <span className={styles.assistantModeBadge}>
              {messageDraft.requiresApproval ? 'Approval required' : 'Sends immediately'}
            </span>
          </div>
          <div className={`mt-14px grid gap-10px ${styles.assistantComposerFields}`}>
            <div className='grid gap-8px md:grid-cols-[minmax(160px,220px)_130px]'>
              <Select
                value={selectedContactId}
                placeholder='Contact'
                allowClear
                onChange={(value) => setSelectedContactId(value || '')}
                options={state.contacts.map((contact) => ({ label: contact.name, value: contact.id }))}
              />
              <Select
                value={messageDraft.channel}
                options={CHANNEL_OPTIONS}
                onChange={updateMessageChannel}
              />
            </div>
            <Input placeholder='Recipient email or phone' value={messageDraft.to} onChange={(to) => setMessageDraft((draft) => ({ ...draft, to }))} />
          </div>
          {messageDraft.channel === 'email' && (
            <Input
              className='mt-8px'
              placeholder='Subject'
              value={messageDraft.subject}
              onChange={(subject) => setMessageDraft((draft) => ({ ...draft, subject }))}
            />
          )}
          <Input.TextArea
            className='mt-8px'
            autoSize={{ minRows: 5, maxRows: 8 }}
            placeholder='Message body'
            value={messageDraft.body}
            onChange={(body) => setMessageDraft((draft) => ({ ...draft, body }))}
          />
          <div className='mt-10px flex flex-wrap items-center justify-between gap-10px'>
            <Checkbox
              checked={messageDraft.requiresApproval}
              onChange={(requiresApproval) => setMessageDraft((draft) => ({ ...draft, requiresApproval }))}
            >
              Require approval before send
            </Checkbox>
            <Button
              type='primary'
              icon={<Send size={14} />}
              onClick={createOutbound}
              disabled={!messageDraft.to.trim() || !messageDraft.body.trim()}
            >
              {messageDraft.requiresApproval ? 'Create draft' : 'Send now'}
            </Button>
          </div>
        </section>

        <section className={`p-16px ${styles.surface} ${styles.assistantOutboxPane}`}>
          <div className='mb-12px flex items-start justify-between gap-10px'>
            <div>
              <h2 className='m-0 text-14px font-700 text-t-primary'>Outbox</h2>
              <p className='m-0 mt-2px text-12px text-t-secondary'>Drafts, approvals, sends, failures, and cancelled messages.</p>
            </div>
            <div className='flex shrink-0 items-center gap-6px'>
              <Button
                size='small'
                type='text'
                status='danger'
                icon={<Trash2 size={13} />}
                disabled={state.outbound.length === 0}
                onClick={clearOutbox}
              >
                Clear
              </Button>
              <Button size='small' type='text' onClick={() => void load()}>
                Refresh
              </Button>
            </div>
          </div>
          <div className={`flex flex-col gap-8px ${styles.assistantOutboxList}`}>
            {state.outbound.map((message) => (
              <div key={message.id} className={`flex flex-wrap items-start gap-12px px-12px py-10px ${styles.card} ${styles.assistantOutboxItem}`}>
                <div className='flex h-32px w-32px shrink-0 items-center justify-center rd-8px bg-fill-2 text-t-secondary'>
                  {channelIcon(message.channel)}
                </div>
                <div className='min-w-0 flex-1'>
                  <div className='flex flex-wrap items-center gap-8px'>
                    <span className='text-13px font-700 text-t-primary'>{message.subject || message.to}</span>
                    <span className={`text-11px font-700 uppercase ${statusTone(message.status)}`}>{message.status}</span>
                    <span className='text-11px text-t-tertiary'>{timestamp(message.sentAt || message.failedAt || message.createTime)}</span>
                  </div>
                  <div className='mt-2px text-12px text-t-secondary'>
                    To {message.contactName ? `${message.contactName} · ` : ''}
                    {message.to}
                  </div>
                  <div className='mt-3px line-clamp-2 text-12px leading-18px text-t-tertiary'>{message.body}</div>
                  {message.error && <div className='mt-3px text-11px text-danger-6'>{message.error}</div>}
                </div>
                <div className='flex shrink-0 flex-wrap gap-6px'>
                  {(message.status === 'pending-approval' || message.status === 'draft' || message.status === 'failed') && (
                    <Button
                      size='small'
                      type='primary'
                      loading={sendingId === message.id}
                      icon={<Check size={13} />}
                      onClick={() => void approveAndSend(message)}
                    >
                      Send
                    </Button>
                  )}
                  {(message.status === 'pending-approval' || message.status === 'draft' || message.status === 'failed') && (
                    <Button size='small' icon={<X size={13} />} onClick={() => void cancel(message.id)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {state.outbound.length === 0 && (
              <div className='rd-8px border border-dashed border-2 px-12px py-14px text-center text-12px text-t-tertiary'>
                No outbound messages yet.
              </div>
            )}
          </div>
        </section>
      </div>

      <div className={`px-14px py-10px text-12px text-t-tertiary ${styles.assistantFooterNote}`}>
        Messages stay project-scoped and auditable. SMS still requires a saved/approved recipient and Twilio availability.
      </div>
    </div>
  );
};

export default ProjectExecutiveAssistantPanel;
