'use strict';

// Skeletons for a new document. Kept pure so the wording and structure can be tested, and so the
// renderer never builds markdown by hand.
//
// {date} and {time} are filled by the caller so the module stays deterministic.

const TEMPLATES = [
  {
    id: 'blank',
    name: { en: 'Blank document', zh: '空白文档' },
    body: '',
  },
  {
    id: 'weekly',
    name: { en: 'Weekly report', zh: '周报' },
    body: [
      '# Weekly report — {date}',
      '',
      '## Done',
      '',
      '- ',
      '',
      '## In progress',
      '',
      '- ',
      '',
      '## Blocked / needs a decision',
      '',
      '- ',
      '',
      '## Next week',
      '',
      '- ',
      '',
    ].join('\n'),
  },
  {
    id: 'meeting',
    name: { en: 'Meeting notes', zh: '会议记录' },
    body: [
      '# Meeting notes — {date}',
      '',
      '- **Attendees:**',
      '- **Purpose:**',
      '',
      '## Agenda',
      '',
      '1. ',
      '',
      '## Notes',
      '',
      '- ',
      '',
      '## Decisions',
      '',
      '- ',
      '',
      '## Actions',
      '',
      '| Owner | Action | Due |',
      '| --- | --- | --- |',
      '|  |  |  |',
      '',
    ].join('\n'),
  },
  {
    id: 'longform',
    name: { en: 'Long-form skeleton', zh: '长文骨架' },
    body: [
      '# Title',
      '',
      'One sentence that says what this piece argues.',
      '',
      '## Opening',
      '',
      'The situation, and why it matters now.',
      '',
      '## Point one',
      '',
      '## Point two',
      '',
      '## What could go wrong',
      '',
      '## Closing',
      '',
      'What the reader should do next.',
      '',
      '> Sources and notes go here until they earn a place in the text.',
      '',
    ].join('\n'),
  },
];

function listTemplates(lang = 'en') {
  return TEMPLATES.map((template) => ({ id: template.id, name: (template.name[lang] || template.name.en) }));
}

function fillTemplate(id, { date = '', lang = 'en' } = {}) {
  const template = TEMPLATES.find((entry) => entry.id === id) || TEMPLATES[0];
  const body = template.body.split('{date}').join(date);
  return { id: template.id, name: template.name[lang] || template.name.en, body };
}

module.exports = { listTemplates, fillTemplate, TEMPLATES };
