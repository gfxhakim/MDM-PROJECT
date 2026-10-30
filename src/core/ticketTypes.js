// Ticket types are data (OA 2.2, AM 2.2). Both module types carry counts_toward: none, which is
// what keeps them out of support SLA, first-response and CSAT metrics (AC-OA-17, AC-26).
export const TICKET_TYPES = Object.freeze({
  onboarding_task: Object.freeze({
    key: 'onboarding_task', module: 'oa', visibility: 'external', defaultTeam: 'Onboarding',
    slaPolicy: null, countsToward: 'none', surveyEligible: false, oneOpenPerContact: true,
    openStatuses: ['new', 'failed_to_contact', 'prequalified', 'qualified'],
    statusCategory: {
      new: 'open', failed_to_contact: 'open', prequalified: 'open', qualified: 'open',
      activated: 'solved', cold_lead: 'closed', junk_lead: 'closed',
    },
  }),
  am_task: Object.freeze({
    key: 'am_task', module: 'am', visibility: 'internal', defaultTeam: 'Account Management',
    slaPolicy: null, countsToward: 'none', surveyEligible: false, oneOpenPerContact: false,
    openStatuses: ['open'],
    statusCategory: { open: 'open', done: 'solved' },
  }),
});

export const isOpen = (ticket) => TICKET_TYPES[ticket.type]?.openStatuses.includes(ticket.status) ?? false;
